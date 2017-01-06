//
// Parse WASM binary format into an in-memory representation.
//
// This is a fairly straightforward procedural parser for the WASM
// binary format.  It generates an object with the following properties:
//
//   XXX TODO: complete this after refactoring
//
//  function (WebAssembly, imports) {
//
//    var asmlib = {
//      <things for asmjs stdlib
//    }
//    var asmimps = {
//      I0: <named imports for asmjs>
//      I1: <...>
//      ...
//      C0: <named constants for
//    }
//
//    var M0 = new WebAssembly.Memory(...)
//    var T0 = new WebAssembly.Table(...)
//
//    var funcs = asmfuncs(asmlib, asmimpos, M0.buffer)
//
//    var exports = {}
//    exports['name'] = funcs.name
//    exports['memory'] = M0
//
//    function asmfuncs(stdlib, foreign, heap) {
//      "waswasm"
//      
//    }
//
//    M0.set([...])
//
//    start()
//
//    return exports
//
//  }
//
// You must provide the array of parsed constants when instantiating
// an instance from the parsed module.
//
// By far the most interesting piece of this module, is the parsing of
// function code.  It current does a direct opcode-by-opcode translation
// into JavaScript, building up an array of strings in memory that we can
// later render into a full function definition.
//
// It's probably worth parsing into an intermediate representation at
// some point, so that we can do some basic optimizations such as converting
// stack accesses into expressions, combining bounds checks, and so-on.
//

import Long from "long"

import stdlib from "./stdlib"
import { CompileError } from "./errors"
import { dump, renderJSValue, makeSigStr } from "./utils"
import {
  PAGE_SIZE,
  TYPES,
  EXTERNAL_KINDS,
  EXTERNAL_KIND_NAMES,
  SECTIONS,
  TOKENS,
  OPCODES
} from "./constants"


export default function parseBinaryEncoding(bytes) {

  var s = new InputStream(bytes)
  var r = new ParseResult()

  parseFileHeader()
  renderJSHeader()
  parseKnownSections()
  renderJSFooter()

  r.finalize()
  return r

  function parseValueType() {
    var v = s.read_varint7()
    if (v >= 0 || v < TYPES.F64) {
      throw new CompileError("Invalid value_type: " + v)
    }
    return v
  }

  function parseBlockType() {
    var v = s.read_varint7()
    if (v >= 0 || (v < TYPES.F64 && v !== TYPES.NONE)) {
      throw new CompileError("Invalid block_type: " + v)
    }
    return v
  }

  function parseElemType() {
    var v = s.read_varint7()
    if (v !== TYPES.ANYFUNC) {
      throw new CompileError("Invalid elem_type: " + v)
    }
    return v
  }

  function parseExternalKind() {
    var v = s.read_uint8()
    if (v > EXTERNAL_KINDS.GLOBAL) {
      throw new CompileError("Invalid external_kind: " + v)
    }
    return v
  }

  function parseFuncType() {
    var f = {}
    f.form = s.read_varint7()
    if (f.form !== TYPES.FUNC) {
      throw new CompileError("Invalid func_type form: " + f.form)
    }
    var param_count = s.read_varuint32()
    f.param_types = []
    while (param_count > 0) {
      f.param_types.push(parseValueType())
      param_count--
    }
    var return_count = s.read_varuint1()
    f.return_types = []
    while (return_count > 0) {
      f.return_types.push(parseValueType())
      return_count--
    }
    return f
  }

  function parseGlobalType() {
    var g = {}
    g.content_type = parseValueType()
    g.mutability = s.read_varuint1()
    return g
  }

  function parseTableType() {
    var t = {}
    t.element_type = parseElemType()
    t.limits = parseResizableLimits()
    return t
  }

  function parseMemoryType() {
    var m = {}
    m.limits = parseResizableLimits()
    if (m.limits.initial > 65536) {
      throw new CompileError("memory size great than 4GiB")
    }
    if (m.limits.maximum && m.limits.maximum > 65536) {
      throw new CompileError("memory size great than 4GiB")
    }
    return m
  }

  function parseResizableLimits() {
    var l = {}
    var flags = s.read_varuint1()
    l.initial = s.read_varuint32()
    if (flags) {
      l.maximum = s.read_varuint32()
      if (l.maximum < l.initial) {
        throw new CompileError("maximum cannot be less than initial")
      }
    } else {
      l.maximum = null
    }
    return l
  }

  function parseInitExpr(typ) {
    var e = {}
    e.op = s.read_byte()
    switch (e.op) {
      case OPCODES.I32_CONST:
        if (typ !== TYPES.I32) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_varint32(), r.constants)
        break
      case OPCODES.I64_CONST:
        if (typ !== TYPES.I64) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_varint64(), r.constants)
        break
      case OPCODES.F32_CONST:
        if (typ !== TYPES.F32) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_float32(), r.constants)
        break
      case OPCODES.F64_CONST:
        if (typ !== TYPES.F64) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_float64(), r.constants)
        break
      case OPCODES.GET_GLOBAL:
        var index = s.read_varuint32()
        if (index >= r.globals.length) {
          throw new CompileError("init_expr refers to non-imported global: " + index)
        }
        if (r.globals[index].type.content_type !== typ) {
          throw new CompileError("init_expr refers to global of incorrect type")
        }
        if (r.globals[index].type.mutability) {
          throw new CompileError("init_expr refers to mutable global")
        }
        e.jsexpr = "G" + index
        break
      default:
        throw new CompileError("Unsupported init expr opcode: 0x" + e.op.toString(16))
    }
    if (s.read_byte() !== OPCODES.END) {
      throw new CompileError("Unsupported init expr code")
    }
    return e
  }

  function parseFileHeader() {
    if (s.read_uint32() !== TOKENS.MAGIC_NUMBER) {
      throw new CompileError("incorrect magic number")
    }
    if (s.read_uint32() !== TOKENS.VERSION_NUMBER) {
      throw new CompileError("incorrect version number")
    }
  }

  function renderJSHeader() {
    r.putln("(function(WebAssembly, constants, asmlib, imports) {")
    r.putln("const Long = WebAssembly._Long")
  }

  function parseKnownSections() {
    while (s.has_more_bytes()) {
      var id = s.read_varuint7()
      var payload_len = s.read_varuint32()
      var next_section_idx = s.idx + payload_len
      // Ignoring named sections for now, but parsing
      // them just enough to detect well-formedness.
      if (! id) {
        var name_len = s.read_varuint32()
        s.read_bytes(name_len)
        s.skip_to(next_section_idx)
        continue
      }
      // Known sections are not allowed to appear out-of-order.
      if (id <= r.lastSection) { throw new CompileError("out-of-order section: " + id.toString()) }
      parseSection(id)
      r.lastSection = id
      // Check that we didn't ready past the declared end of section.
      // It's OK if there was some extra padding garbage in the payload data.
      s.skip_to(next_section_idx)
    }
  }

  function parseSection(id) {
    switch (id) {
      case SECTIONS.TYPE:
	return parseTypeSection()
      case SECTIONS.IMPORT:
	return parseImportSection()
      case SECTIONS.FUNCTION:
	return parseFunctionSection()
      case SECTIONS.TABLE:
	return parseTableSection()
      case SECTIONS.MEMORY:
	return parseMemorySection()
      case SECTIONS.GLOBAL:
	return parseGlobalSection()
      case SECTIONS.EXPORT:
	return parseExportSection()
      case SECTIONS.START:
	return parseStartSection()
      case SECTIONS.ELEMENT:
	return parseElementSection()
      case SECTIONS.CODE:
	return parseCodeSection()
      case SECTIONS.DATA:
	return parseDataSection()
      default:
	throw new CompileError("unknown section code: " + id)
    }
  }

  function parseTypeSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      r.types.push(parseFuncType())
      count--
    }
  }

  function parseImportSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      r.imports.push(parseImportEntry())
      count--
    }

    function parseImportEntry() {
      var i = {}
      var module_len = s.read_varuint32()
      i.module_name = s.read_bytes(module_len)
      var field_len = s.read_varuint32()
      i.item_name = s.read_bytes(field_len)
      i.kind = parseExternalKind()
      switch (i.kind) {
        // Imported functions get rendered in the asmjs sub-function.
	case EXTERNAL_KINDS.FUNCTION:
	  i.type = s.read_varuint32()
	  if (i.type >= r.types.length) {
	    throw new CompileError("import has unknown type: " + i.type)
	  }
          i.index = r.numImportedFunctions++
          i.name = "F" + i.index
          r.functions.push(i)
	  break
        // Imported globals get rendered twice, so they're visible in both scopes
        // while staying within the rules of asmjs.
	case EXTERNAL_KINDS.GLOBAL:
	  i.type = parseGlobalType()
	  if (i.type.mutability) {
	    throw new CompileError("mutable globals cannot be imported")
	  }
          i.index = r.numImportedGlobals++
          // Exported immutable global, just repeat its declaration
          // here and in the asmjs sub-function.
          r.putln("var G", i.index, " = imports.G", i.index)
          r.globals.push(i)
	  break
        // Imported tables and memories get rendered in the top-level function.
	case EXTERNAL_KINDS.TABLE:
	  if (r.tables.length > 0) {
	    throw new CompileError("multiple tables")
	  }
	  i.type = parseTableType()
          r.putln("var T", r.tables.length, " = imports.T", r.tables.length)
          i.index = r.numImportedTables++
          r.tables.push(i.type)
	  break
	case EXTERNAL_KINDS.MEMORY:
	  if (r.memories.length > 0) {
	    throw new CompileError("multiple memories")
	  }
	  i.type = parseMemoryType()
          r.putln("var M", r.memories.length, " = imports.M", r.memories.length)
          i.index = r.numImportedMemories++
          r.memories.push(i.type)
	  break
	default:
	  throw new CompileError("unknown import kind:" + i.kind)
      }
      return i
    }
  }

  function parseFunctionSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      var f = { type: s.read_varuint32() }
      if (f.type >= r.types.length) {
        throw new CompileError("function has unknown type: " + f.type)
      }
      f.index = r.functions.length
      f.name = "F" + f.index
      r.functions.push(f)
      count--
    }
  }

  function parseTableSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      if (r.tables.length > 0) {
	throw new CompileError("multiple tables")
      }
      var t = parseTableType()
      r.putln("var T", r.tables.length, " = new WebAssembly.Table(", JSON.stringify(t.limits), ")")
      r.tables.push(t)
      count--
    }
    if (r.tables.length > 1) {
      throw new CompileError("more than one table entry")
    }
  }

  function parseMemorySection() {
    var count = s.read_varuint32()
    while (count > 0) {
      if (r.memories.length > 0) {
	throw new CompileError("multiple memories")
      }
      var m = parseMemoryType()
      r.putln("var M", r.memories.length, " = new WebAssembly.Memory(", JSON.stringify(m.limits), ")")
      r.memories.push(m)
      count--
    }
    if (r.memories.length > 1) {
      throw new CompileError("more than one memory entry")
    }
  }

  function parseGlobalSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      var g = parseGlobalVariable()
      r.globals.push(g)
      count--
    }

    function parseGlobalVariable() {
      var g = {}
      g.type = parseGlobalType()
      g.init = parseInitExpr(g.type.content_type)
      return g
    }
  }

  var _haveRenderedAsmFuncsCreation = false
  var _haveRenderedAsmFuncsHeader = false
  var _haveRenderedAsmFuncsFooter = false

  function renderAsmFuncsCreation() {
    if (_haveRenderedAsmFuncsCreation) {
      return
    }
    _haveRenderedAsmFuncsCreation = true

    // Create a dynamic call helper for each type signature.
    if (r.tables.length === 1) {
      r.types.forEach(function(t) {
        var sigStr = makeSigStr(t)
        var args = ["idx"]
        for (var i = 0; i < t.param_types.length; i++) {
          args.push("a" + i)
        }
        r.putln("imports.call_", sigStr, " = function call_", sigStr, "(", args.join(","), "){")
        r.putln("  idx = idx >>> 0")
        r.putln("  if (idx >= T0.length) { imports.trap('table oob') }")
        r.putln("  var func = T0.get(idx)")
        r.putln("  if (func === null) { imports.trap('table entry') }")
        r.putln("  if (func._wasmTypeSigStr) {")
        r.putln("    if (func._wasmTypeSigStr !== '", sigStr, "') { imports.trap('table sig') }")
        r.putln("  }")
        r.putln("  return func(", args.slice(1).join(","), ")")
        r.putln("}")
      })
    }

    // Create unaligned memory-access helpers.
    // These need to be dynamically created in order
    // to close over a reference to the heap.
    r.memories.forEach(function(m, idx) {
      r.putln("var HDV = new DataView(M", idx, ".buffer)")
      r.putln("var HU8 = new Uint8Array(M", idx, ".buffer)")
      if (m.limits.initial !== m.limits.maximum) {
        r.putln("M", idx, "._onChange(function() {")
        r.putln("  HU8 = new Uint8Array(M", idx, ".buffer)")
        r.putln("  HDV = new DataView(M", idx, ".buffer)")
        r.putln("});")
      }
      r.putln("imports.i32_load_unaligned = function(addr) {")
      r.putln("  return HDV.getInt32(addr, true)")
      r.putln("}")
      r.putln("imports.i32_load16_s_unaligned = function(addr) {")
      r.putln("  return HDV.getInt16(addr, true)")
      r.putln("}")
      r.putln("imports.i32_load16_u_unaligned = function(addr) {")
      r.putln("  return HDV.getInt16(addr, true) & 0x0000FFFF")
      r.putln("}")
      r.putln("imports.f32_load_unaligned = function(addr) {")
      r.putln("  return HDV.getFloat32(addr, true)")
      r.putln("}")
      r.putln("imports.f64_load_unaligned = function(addr) {")
      r.putln("  return HDV.getFloat64(addr, true)")
      r.putln("}")
      r.putln("imports.i32_store_unaligned = function(addr, value) {")
      r.putln("  HDV.setInt32(addr, value, true)")
      r.putln("}")
      r.putln("imports.i32_store16_unaligned = function(addr, value) {")
      r.putln("  HDV.setInt16(addr, value & 0x0000FFFF, true)")
      r.putln("}")
      r.putln("imports.f32_store_unaligned = function(addr, value) {")
      r.putln("  HDV.setFloat32(addr, value, true)")
      r.putln("}")
      r.putln("imports.f64_store_unaligned = function(addr, value) {")
      r.putln("  HDV.setFloat64(addr, value, true)")
      r.putln("}")
      r.putln("imports.f32_load_fix_signalling = function(v, addr) {")
      r.putln("  if (isNaN(v)) {")
      r.putln("    if (!(HU8[addr + 2] & 0x40)) {")
      r.putln("      v = new Number(v)")
      r.putln("      v._signalling = true")
      r.putln("    }")
      r.putln("  }")
      r.putln("  return v")
      r.putln("}")
      r.putln("imports.f32_store_fix_signalling = function(v, addr) {")
      r.putln("  if (isNaN(v)) {")
      r.putln("    if (typeof v === 'object' && v._signalling) {")
      r.putln("      HU8[addr + 2] &= ~0x40")
      r.putln("    }")
      r.putln("  }")
      r.putln("}")
    })

    // Invoke the asmjs sub-function, creating the function objects.
    if (r.functions.length > 0) {
      if (r.memories.length === 1) {
        r.putln("var funcs = asmfuncs(asmlib, imports, M0.buffer)")
      } else {
        r.putln("var funcs = asmfuncs(asmlib, imports)")
      }
    }

    // Type-tag each returned function.
    r.functions.forEach(function(f, idx) {
      r.putln("funcs.", f.name, "._wasmTypeSigStr = '", makeSigStr(getFunctionSignature(idx)), "'")
      r.putln("funcs.", f.name, "._wasmJSWrapper = null")
    })
  }

  function renderAsmFuncsHeader() {
    if (_haveRenderedAsmFuncsHeader) {
      return
    }
    _haveRenderedAsmFuncsHeader = true

    r.putln("function asmfuncs(stdlib, foreign, heap) {")
    r.putln("\"use asm\"")

    // Make heap views, if one was given.
    // If the heap is not growable then we can hard-code
    // the memory size and remain valid asmjs.

    r.memories.forEach(function(m, idx) {
      var buf
      if (idx > 0 || m.limits.initial !== m.limits.maximum) {
        buf = "M" + idx + ".buffer"
        r.putln("var memorySize = ", buf, ".byteLength|0")
      } else {
        buf = "heap"
        r.putln("var memorySize = ", m.limits.initial * PAGE_SIZE)
      }
      r.putln("var HI8 = new stdlib.Int8Array(", buf, ")")
      r.putln("var HI16 = new stdlib.Int16Array(", buf, ")")
      r.putln("var HI32 = new stdlib.Int32Array(", buf, ")")
      r.putln("var HU8 = new stdlib.Uint8Array(", buf, ")")
      r.putln("var HU16 = new stdlib.Uint16Array(", buf, ")")
      r.putln("var HU32 = new stdlib.Uint32Array(", buf, ")")
      r.putln("var HF32 = new stdlib.Float32Array(", buf, ")")
      r.putln("var HF64 = new stdlib.Float64Array(", buf, ")")
      if (m.limits.initial !== m.limits.maximum) {
        r.putln("M", idx, "._onChange(function() {")
        r.putln("  memorySize = ", buf, ".byteLength|0")
        r.putln("  HI8 = new stdlib.Int8Array(", buf, ")")
        r.putln("  HI16 = new stdlib.Int16Array(", buf, ")")
        r.putln("  HI32 = new stdlib.Int32Array(", buf, ")")
        r.putln("  HU8 = new stdlib.Uint8Array(", buf, ")")
        r.putln("  HU16 = new stdlib.Uint16Array(", buf, ")")
        r.putln("  HU32 = new stdlib.Uint32Array(", buf, ")")
        r.putln("  HF32 = new stdlib.Float32Array(", buf, ")")
        r.putln("  HF64 = new stdlib.Float64Array(", buf, ")")
        r.putln("});")
      }
    })

    // Take local references to our helper functions.

    r.putln("var fround = stdlib.Math.fround")
    Object.keys(stdlib).forEach(function(key) {
      r.putln("var ", key, " = foreign.", key)
    })

    // Take local references to all the imports.

    r.imports.forEach(function(i, idx) {
      switch (i.kind) {
	case EXTERNAL_KINDS.FUNCTION:
          r.putln("var F", i.index, " = foreign.F", i.index)
	  break
	case EXTERNAL_KINDS.GLOBAL:
          switch (i.type.content_type) {
            case TYPES.I32:
              r.putln("var G", i.index, " = foreign.G", i.index, "|0")
              break
            case TYPES.I64:
              r.putln("var G", i.index, " = foreign.G", i.index)
              break
            case TYPES.F32:
              r.putln("var G", i.index, " = fround(foreign.G", i.index, ")")
              break
            case TYPES.F64:
              r.putln("var G", i.index, " = +foreign.G", i.index)
              break
          }
	  break
      }
    })

    // Take local references to dynamic call helpers.

    if (r.tables.length === 1) {
      r.types.forEach(function(t) {
        var sigStr = makeSigStr(t)
        r.putln("var call_", sigStr, " = foreign.call_", sigStr)
      })
    }

    // Take local references to unaligned load/store helpers.

    r.putln("var i32_load_unaligned = foreign.i32_load_unaligned")
    r.putln("var i32_load16_s_unaligned = foreign.i32_load16_s_unaligned")
    r.putln("var i32_load16_u_unaligned = foreign.i32_load16_u_unaligned")
    r.putln("var f32_load_unaligned = foreign.f32_load_unaligned")
    r.putln("var f64_load_unaligned = foreign.f64_load_unaligned")
    r.putln("var i32_store_unaligned = foreign.i32_store_unaligned")
    r.putln("var i32_store16_unaligned = foreign.i32_store16_unaligned")
    r.putln("var f32_store_unaligned = foreign.f32_store_unaligned")
    r.putln("var f64_store_unaligned = foreign.f64_store_unaligned")
    r.putln("var f32_load_fix_signalling = foreign.f32_load_fix_signalling")
    r.putln("var f32_store_fix_signalling = foreign.f32_store_fix_signalling")

    // Declare all the global variables.
    // This repeats the declaration of any globals that were exported,
    // but they're immutable, so whatevz.

    r.globals.forEach(function(g, idx) {
      if (idx >= r.numImportedGlobals) {
        switch (g.type.content_type) {
          case TYPES.I32:
            r.putln("var G", idx, " = ", g.init.jsexpr, "|0")
            break
          case TYPES.I64:
            r.putln("var G", idx, " = ", g.init.jsexpr)
            break
          case TYPES.F32:
            r.putln("var G", idx, " = fround(", g.init.jsexpr, ")")
            break
          case TYPES.F64:
            r.putln("var G", idx, " = +", g.init.jsexpr)
            break
        }
      }
    })

    // XXX TODO: if the there's a single, ungrowable table that's
    // neither imported nor exported, we could declare its contents
    // inline here and made the generated code faster.

    // That's it, now we can render function definitions.
  }

  function renderAsmFuncsFooter() {
    if (_haveRenderedAsmFuncsFooter) {
      return
    }
    _haveRenderedAsmFuncsFooter = true
    // We return *all* the functions from the asmj module,
    // so that we can put them into tables etc.
    r.putln("return {")
    r.functions.forEach(function(f, idx) {
      r.putln("  F", idx, ": F", idx, (idx === r.functions.length - 1) ? "" : ",")
    })
    r.putln("}")
    r.putln("}")
  }

  function parseExportSection() {
    renderAsmFuncsCreation()
    r.putln("var exports = {}")

    var count = s.read_varuint32()
    var seenFields = {}
    while (count > 0) {
      r.exports.push(parseExportEntry())
      count--
    }

    function parseExportEntry() {
      var e = {}
      var field_len = s.read_varuint32()
      e.field = s.read_bytes(field_len)
      if (e.field in seenFields) {
	throw new CompileError("duplicate export name: " + e.field)
      }
      seenFields[e.field] = true
      e.kind = parseExternalKind()
      e.index = s.read_varuint32()
      var ref = "trap('invalid export')"
      switch (e.kind) {
	case EXTERNAL_KINDS.FUNCTION:
	  if (e.index >= r.functions.length) {
	    throw new CompileError("export of non-existent function")
	  }
	  ref = "funcs.F" + e.index
          r.numExportedFunctions++
	  break
	case EXTERNAL_KINDS.GLOBAL:
	  if (e.index >= r.globals.length) {
	    throw new CompileError("export of non-existent global")
	  }
	  if (getGlobalMutability(e.index)) {
	    throw new CompileError("mutable globals cannot be exported")
	  }
          // Exported immutable global, just repeat its declaration
          // here and in the asmjs sub-function.  Any imported ones
          // will already have been done by the imports section.
          if (e.index >= r.numImportedGlobals) {
            r.putln("var G", e.index, " = ", r.globals[e.index].init.jsexpr)
          }
	  ref = "G" + e.index
          r.numExportedGlobals++
	  break
	case EXTERNAL_KINDS.TABLE:
	  if (e.index >= r.tables.length) {
	    throw new CompileError("export of non-existent table")
	  }
	  ref = "T" + e.index
          r.numExportedTables++
	  break
	case EXTERNAL_KINDS.MEMORY:
	  if (e.index >= r.memories.length) {
	    throw new CompileError("export of non-existent memory")
	  }
	  ref = "M" + e.index
          r.numExportedMemories++
	  break
	default:
	  throw new CompileError("unchecked export kind: " + e.kind)
      }
      r.putln("exports[", renderJSValue(e.field, r.constants), "] = " + ref)
      return e
    }
  }

  function parseStartSection() {
    var func_index = s.read_varuint32()
    var sig = getFunctionSignature(func_index)
    if (sig.param_types.length > 0) {
      throw new CompileError("start function must take no parameters")
    }
    if (sig.return_types.length > 0) {
      throw new CompileError("start function must return no results")
    }
    r.start = func_index
  }

  function parseElementSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      var e = parseElementSegment()
      r.elements.push(e)
      count--
    }

    function parseElementSegment() {
      var e = {}
      e.index = s.read_varuint32()
      if (e.index !== 0) {
	throw new CompileError("MVP requires elements index be zero")
      }
      // Check that it's a valid table reference.
      getTableType(e.index)
      e.offset = parseInitExpr(TYPES.I32)
      var num_elems = e.num_elems = s.read_varuint32()
      var elems = []
      var pos = 0
      while (num_elems > 0) {
        elems.push("funcs.F" + s.read_varuint32())
	num_elems--
        if (elems.length >= 1024 || num_elems === 0) {
          r.putln("T", e.index, "._setmany((", e.offset.jsexpr, ") + ", pos, ", [", elems.join(","), "])")
          pos += elems.length
          elems = []
        }
      }
      return e
    }
  }

  function parseCodeSection() {

    var count = s.read_varuint32()
    if (count + r.numImportedFunctions !== r.functions.length) {
      throw new CompileError("code section size different to function section size")
    }

    renderAsmFuncsHeader()
    
    var n = r.numImportedFunctions
    while (count > 0) {
      parseFunctionBody(n)
      count--
      n++
    }

    renderAsmFuncsFooter()

    function parseFunctionBody(index) {
      var f = {}
      f.name = "F" + index
      f.sig = getFunctionSignature(index)
      f.sigStr = makeSigStr(f.sig)
      var body_size = s.read_varuint32()
      var end_of_body_idx = s.idx + body_size
      var local_count = s.read_varuint32()
      f.locals = []
      while (local_count > 0) {
	f.locals.push(parseLocalEntry())
	local_count--
      }
      parseFunctionCode(f)
      s.skip_to(end_of_body_idx)
      return f
    }

    function parseLocalEntry() {
      var e = {}
      e.count = s.read_varuint32()
      e.type = parseValueType()
      return e
    }

    // OK, this is where is gets interesting.
    // We attempt to convert the WASM opcode into a corresponding
    // javascript function.  It will be asmjs-like but we're not
    // going to worry about full validating asm compliance just yet,
    // not least because that doesn't support growable memory anyway.

    function parseFunctionCode(f) {
      var c = {}
      var header_lines = []
      var body_lines = []

      var declaredVars = {}

      header_lines.push("function " + f.name + "(" + makeParamList() + ") {")
      f.sig.param_types.forEach(function(typ, idx) {
        var nm = getLocalVar(idx, typ, true)
        switch (typ) {
          case TYPES.I32:
            header_lines.push(nm + " = " + nm + "|0")
            break
          case TYPES.I64:
            break
          /* these break our NaN-boxing
          case TYPES.F32:
            header_lines.push(nm + " = ToF32(" + nm + ")")
            break
          case TYPES.F64:
            header_lines.push(nm + " = +" + nm)
            break*/
        }
      })

      function makeParamList() {
	var params = []
	f.sig.param_types.forEach(function(typ, idx) {
	  params.push(getLocalVar(idx, typ, true))
	})
	return params.join(",")
      }

      // We represent WASM's "structured stack" as a "stack of stacks".
      // Each time we enter a block, we push a new stack on top of
      // the existing control-flow structures.  Code can only access
      // items from within this top-most stack, not any of the stacks
      // below it.
      //
      // XXX TODO: this code should be refactored out into a helper class
      // rather than using a bunch of inline function definitions.

      var cfStack = [{
	op: 0,
	sig: (f.sig.return_types.length > 0 ? f.sig.return_types[0] : TYPES.NONE),
	index: 0,
	isDead: false,
	isPolymorphic: false,
	endReached: false,
	typeStack: [],
	prevStackHeights: {}
      }]
      cfStack[0].prevStackHeights[TYPES.I32] = 0
      cfStack[0].prevStackHeights[TYPES.I64] = 0
      cfStack[0].prevStackHeights[TYPES.F32] = 0
      cfStack[0].prevStackHeights[TYPES.F64] = 0

      function printStack() {
	dump("--")
	for (var i = cfStack.length - 1; i >= 0; i--) {
	  dump(cfStack[i].isDead ? "x" : "-", cfStack[i].typeStack)
	}
	dump("--")
      }

      function pushControlFlow(op, sig, endReached) {
	var prevCf = cfStack[cfStack.length - 1]
	var prevStackHeights = {}
	prevStackHeights[TYPES.I32] = prevCf.prevStackHeights[TYPES.I32]
	prevStackHeights[TYPES.I64] = prevCf.prevStackHeights[TYPES.I64]
	prevStackHeights[TYPES.F32] = prevCf.prevStackHeights[TYPES.F32]
	prevStackHeights[TYPES.F64] = prevCf.prevStackHeights[TYPES.F64]
	prevCf.typeStack.forEach(function(typ) {
	  prevStackHeights[typ] += 1
	})
	cfStack.push({
	  op: op,
	  sig: sig,
	  index: cfStack.length,
	  label: "L" + cfStack.length,
	  isPolymorphic: false,
	  isDead: prevCf.isDead,
	  endReached: !!endReached,
	  typeStack: [],
	  prevStackHeights: prevStackHeights
	})
	return cfStack[cfStack.length - 1]
      }

      function popControlFlow() {
	cf = cfStack.pop()
	return cf
      }

      function markDeadCode() {
	var cf = cfStack[cfStack.length - 1]
	cf.isDead = true
	cf.isPolymorphic = true
	cf.typeStack = []
      }

      function isDeadCode() {
	return cfStack[cfStack.length - 1].isDead
      }

      function pushLine(ln, indent) {
	if (isDeadCode()) {
          body_lines.push("trap('dead code')")
          return
        }
	var indent = cfStack.length + (indent || 0) + 1
	while (indent > 0) {
	  ln = "  " + ln
	  indent--
	}
	body_lines.push(ln)
      }

      function pushStackVar(typ) {
	cfStack[cfStack.length - 1].typeStack.push(typ)
	return getStackVar(typ)
      }

      function peekStackType() {
	var cf = cfStack[cfStack.length - 1]
	var stack = cf.typeStack
	if (stack.length === 0) {
	  if (! cf.isPolymorphic) {
	    throw new CompileError("nothing on the stack")
	  }
	  return TYPES.UNKNOWN
	}
	return stack[stack.length - 1]
      }

      function popStackVar(wantType) {
	var name = getStackVar(wantType)
	var cf = cfStack[cfStack.length - 1]
	var typ = cf.typeStack.pop()
	if (wantType !== TYPES.UNKNOWN && typ !== wantType && typ !== TYPES.UNKNOWN) {
	  if (! cf.isPolymorphic) {
	    throw new CompileError("Stack type mismatch: expected " + wantType + ", found " + typ)
	  }
	  return "UNREACHABLE"
	}
	return name
      }

      function getStackVar(typ, pos) {
	var cf = cfStack[cfStack.length - 1]
	var where = cf.typeStack.length - 1
	where -= (pos || 0)
	if (where < 0) {
	  if (! cf.isPolymorphic) {
	    throw new CompileError("stack access outside current block")
	  }
	  return "UNREACHABLE"
	}
	if (typ !== cf.typeStack[where] && typ !== TYPES.UNKNOWN && cf.typeStack[where] !== TYPES.UNKNOWN) {
	  throw new CompileError("Stack type mismatch: expected " + typ + ", found " + cf.typeStack[where])
	}
	var height = cf.prevStackHeights[typ]
	for (var i = 0; i < where; i++) {
	  if (cf.typeStack[i] === typ) {
	    height += 1
	  }
	}
	var nm
	switch (typ) {
	  case TYPES.I32:
	    nm = "si" + height
	    break
	  case TYPES.I64:
	    nm = "sl" + height
	    break
	  case TYPES.F32:
	    nm = "sf" + height
	    break
	  case TYPES.F64:
	    nm = "sd" + height
	    break
	  case TYPES.UNKNOWN:
	    nm = "UNREACHABLE"
	    break
	  default:
	    throw new CompileError("unexpected type on stack: " + typ)
	}
	declareVarName(typ, nm)
	return nm
      }

      function getBlockOutputVar(cf) {
	if (cf.sig === TYPES.NONE) {
	  throw new CompileError("No output from void block")
	}
	var height = cf.prevStackHeights[cf.sig]
	switch (cf.sig) {
	  case TYPES.I32:
	    return "si" + height
	  case TYPES.I64:
	    return "sl" + height
	  case TYPES.F32:
	    return "sf" + height
	  case TYPES.F64:
	    return "sd" + height
	  default:
	    throw new CompileError("unexpected type on stack")
	}
      }

      function getBranchTarget(depth) {
	var which = cfStack.length - (1 + depth)
	if (which < 0) {
	  throw new CompileError("Branch depth too large")
	}
	return cfStack[which]
      }

      function getLocalType(index) {
	var count = f.sig.param_types.length
	if (index < count) {
	  return f.sig.param_types[index]
	}
	var next = 0
	while (next < f.locals.length) {
	  count += f.locals[next].count
	  if (count > index) {
	    return f.locals[next].type
	  }
	  next++
	}
	throw new CompileError("local index too large: " + index)
      }

      function getLocalVar(index, typ, param) {
	typ = typ || getLocalType(index)
	var nm
	switch (typ) {
	  case TYPES.I32:
	    nm =  "li" + index
	    break
	  case TYPES.I64:
	    nm = "ll" + index
	    break
	  case TYPES.F32:
	    nm = "lf" + index
	    break
	  case TYPES.F64:
	    nm = "ld" + index
	    break
	  default:
	    throw new CompileError("unexpected type of local")
	}
	if (! param) {
	  declareVarName(typ, nm)
	} else {
	  declaredVars[nm] = true
	}
	return nm
      }

      function declareVarName(typ, nm) {
	var initVal = "trap('invalid initial value')"
	switch (typ) {
	  case TYPES.I32:
	    initVal = "0"
	    break
	  case TYPES.I64:
	    initVal = "Long.ZERO"
	    break
	  case TYPES.F32:
	    initVal = "0.0"
	    break
	  case TYPES.F64:
	    initVal = "0.0"
	    break
	  case TYPES.UNKNOWN:
	    return
	  default:
	    throw new CompileError("unexpected type of variable")
	}
	if (! declaredVars[nm]) {
	  header_lines.push("    var " + nm + " = " + initVal)
	  declaredVars[nm] = true
	}
      }

      function getGlobalVar(index, typ) {
	return "G" + index
      }

      function checkGlobalMutable(index) {
	if (index >= r.globals.length) {
	  throw new CompileError("checkGlobalMut: no such global: " + index)
	}
	if (! r.globals[index].type.mutability) {
	  throw new CompileError("global is immutable: " + index)
	}
      }

      function i32_unaryOp(what, cast) {
	cast = cast || "|0"
	var operand = getStackVar(TYPES.I32)
	pushLine(operand + " = (" + what + "(" + operand + "))" + cast)
      }

      function i32_binaryOp(what, cast) {
	cast = cast || "|0"
	var rhs = "(" + popStackVar(TYPES.I32) + cast + ")"
	var lhs = "(" + popStackVar(TYPES.I32) + cast + ")"
	pushLine(pushStackVar(TYPES.I32) + " = (" + lhs + what + rhs + ")" + cast)
      }

      function i32_binaryFunc(what, cast) {
	cast = cast || "|0"
	var rhs = "(" + popStackVar(TYPES.I32) + cast + ")"
	var lhs = "(" + popStackVar(TYPES.I32) + cast + ")"
	pushLine(pushStackVar(TYPES.I32) + " = (" + what + "(" + lhs + ", " + rhs + "))" + cast)
      }

      function i64_unaryFunc(what) {
	var operand = getStackVar(TYPES.I64)
	pushLine(operand + " = " + what + "(" + operand + ")")
      }

      function i64_binaryFunc(what) {
	var rhs = "(" + popStackVar(TYPES.I64) + ")"
	var lhs = "(" + popStackVar(TYPES.I64) + ")"
	pushLine(pushStackVar(TYPES.I64) + " = " + what + "(" + lhs + ", " + rhs + ")")
      }

      function i64_compareFunc(what) {
	var rhs = "(" + popStackVar(TYPES.I64) + ")"
	var lhs = "(" + popStackVar(TYPES.I64) + ")"
	pushLine(pushStackVar(TYPES.I32) + " = " + what + "(" + lhs + ", " + rhs + ")|0")
      }

      function f32_compareOp(what) {
	var rhs = popStackVar(TYPES.F32)
	var lhs = popStackVar(TYPES.F32)
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = (" + lhs + " " + what + " " + rhs + ")|0")
      }

      function f32_unaryOp(what) {
	var operand = popStackVar(TYPES.F32)
	pushLine(pushStackVar(TYPES.F32) + " = ToF32(" + what +"(" + operand + "))")
      }

      function f32_binaryOp(what) {
	var rhs = popStackVar(TYPES.F32)
	var lhs = popStackVar(TYPES.F32)
	pushLine(pushStackVar(TYPES.F32) + " = ToF32(" + lhs + " " + what + " " + rhs + ")")
      }

      function f32_binaryFunc(what) {
	var rhs = popStackVar(TYPES.F32)
	var lhs = popStackVar(TYPES.F32)
	pushLine(pushStackVar(TYPES.F32) + " = ToF32(" + what + "(" + lhs + ", " + rhs + "))")
      }

      function f64_compareOp(what) {
	var rhs = popStackVar(TYPES.F64)
	var lhs = popStackVar(TYPES.F64)
	pushLine(pushStackVar(TYPES.I32) + " = (" + lhs + " " + what + " " + rhs + ")|0")
      }

      function f64_unaryOp(what) {
	var operand = popStackVar(TYPES.F64)
	pushLine(pushStackVar(TYPES.F64) + " = " + what +"(" + operand + ")")
      }

      function f64_binaryOp(what) {
	var rhs = popStackVar(TYPES.F64)
	var lhs = popStackVar(TYPES.F64)
	pushLine(pushStackVar(TYPES.F64) + " = " + lhs + " " + what + " " + rhs)
      }

      function f64_binaryFunc(what) {
	var rhs = popStackVar(TYPES.F64)
	var lhs = popStackVar(TYPES.F64)
	pushLine(pushStackVar(TYPES.F64) + " = " + what + "(" + lhs + ", " + rhs + ")")
      }

      function boundsCheck(addr, offset, size) {
	pushLine("if ((" + addr + ">>>0) + " + (offset + size) + " > memorySize) { return trap('OOB') }")
      }

      function i32_load_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = i32_load_unaligned(" + addr + " + " + offset + ")")
      }

      function i32_load_aligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  " + res + " = i32_load_unaligned(" + addr + " + " + offset + ")")
	pushLine("} else {")
	pushLine("  " + res + " = HI32[(" + addr + " + " + offset + ")>>2]")
	pushLine("}")
      }

      function i32_load8_s(addr, offset, value) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = HI8[(" + addr + " + " + offset + ")]")
      }

      function i32_load8_u(addr, offset, value) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = HU8[(" + addr + " + " + offset + ")]")
      }

      function i32_load16_s_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = i32_load16_s_unaligned(" + addr + " + " + offset + ")")
      }

      function i32_load16_u_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = i32_load16_u_unaligned(" + addr + " + " + offset + ")")
      }

      function i32_load16_s_aligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
	pushLine("  " + res + " = i32_load16_s_unaligned(" + addr + " + " + offset + ")")
	pushLine("} else {")
	pushLine("  " + res + " = HI16[(" + addr + " + " + offset + ")>>1]")
	pushLine("}")
      }

      function i32_load16_u_aligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
	pushLine("  " + res + " = i32_load16_u_unaligned(" + addr + " + " + offset + ")")
	pushLine("} else {")
	pushLine("  " + res + " = HU16[(" + addr + " + " + offset + ")>>1]")
	pushLine("}")
      }

      function i32_store_unaligned(addr, offset, value) {
	pushLine("i32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
      }

      function i32_store_aligned(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  i32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
	pushLine("} else {")
	pushLine("  HI32[(" + addr + " + " + offset + ")>>2] = " + value)
	pushLine("}")
      }

      function i32_store8(addr, offset, value) {
	pushLine("HU8[(" + addr + " + " + offset + ")] = " + value)
      }

      function i32_store16(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
	pushLine("  i32_store16_unaligned(" + addr + " + " + offset + ", " + value + ")")
	pushLine("} else {")
	pushLine("  HU16[(" + addr + " + " + offset + ")>>1] = " + value)
	pushLine("}")
      }

      function f32_load_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.F32)
	pushLine(res + " = f32_load_unaligned(" + addr + " + " + offset + ")")
	pushLine(res + " = f32_load_fix_signalling(" + res + ", " + addr + " + " + offset + ")")
      }

      function f32_load_aligned(addr, offset) {
	var res = pushStackVar(TYPES.F32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  " + res + " = f32_load_unaligned(" + addr + " + " + offset + ")")
	pushLine("} else {")
	pushLine("  " + res + " = HF32[(" + addr + " + " + offset + ")>>2]")
	pushLine("}")
	pushLine(res + " = f32_load_fix_signalling(" + res + ", " + addr + " + " + offset + ")")
      }

      function f32_store_unaligned(addr, offset, value) {
	pushLine("f32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
	pushLine("f32_store_fix_signalling(" + value + ", " + addr + " + " + offset + ")")
      }

      function f32_store_aligned(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  f32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
	pushLine("} else {")
	pushLine("  HF32[(" + addr + " + " + offset + ")>>2] = " + value)
	pushLine("}")
	pushLine("f32_store_fix_signalling(" + value + ", " + addr + " + " + offset + ")")
      }

      function f64_load_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.F64)
	pushLine(res + " = f64_load_unaligned(" + addr + " + " + offset + ")")
      }

      function f64_load_aligned(addr, offset) {
	var res = pushStackVar(TYPES.F64)
	pushLine("if ((" + addr + " + " + offset + ") & 0x07) {")
	pushLine("  " + res + " = f64_load_unaligned(" + addr + " + " + offset + ")")
	pushLine("} else {")
	pushLine("  " + res + " = HF64[(" + addr + " + " + offset + ")>>3]")
	pushLine("}")
      }

      function f64_store_unaligned(addr, offset, value) {
	pushLine("f64_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
      }

      function f64_store_aligned(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x07) {")
	pushLine("  f64_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
	pushLine("} else {")
	pushLine("  HF64[(" + addr + " + " + offset + ")>>3] = " + value)
	pushLine("}")
      }

      function i64_from_i32_s() {
	var low32 = popStackVar(TYPES.I32)
	var res = pushStackVar(TYPES.I64)
        // Sign-extend into 64 bits
	pushLine("if (" + low32 + " & 0x80000000) {")
	pushLine("  " + res + " = new Long(" + low32 + ", -1)")
	pushLine("} else {")
	pushLine("  " + res + " = new Long(" + low32 + ", 0)")
	pushLine("}")
      }

      function i64_from_i32_u() {
	var low32 = popStackVar(TYPES.I32)
	pushLine(pushStackVar(TYPES.I64) + " = new Long(" + low32 + ", 0)")
      }

      function i64_from_i32x2() {
	var high32 = popStackVar(TYPES.I32)
	var low32 = popStackVar(TYPES.I32)
	pushLine(pushStackVar(TYPES.I64) + " = new Long(" + low32 + ", " + high32 + ")")
      }

      DECODE: while (true) {
	var op = s.read_byte()
	switch (op) {

	  case OPCODES.UNREACHABLE:
	    pushLine("return trap('unreachable')")
	    markDeadCode()
	    break

	  case OPCODES.NOP:
	    break

	  case OPCODES.BLOCK:
	    var sig = parseBlockType()
	    var cf = pushControlFlow(op, sig)
	    pushLine(cf.label + ": do {", -1)
	    break

	  case OPCODES.LOOP:
	    var sig = parseBlockType()
	    var cf = pushControlFlow(op, sig)
	    pushLine(cf.label + ": while (1) {", -1)
	    break

	  case OPCODES.IF:
	    var sig = parseBlockType()
	    var cond = popStackVar(TYPES.I32)
	    var cf = pushControlFlow(op, sig)
	    pushLine(cf.label + ": do { if ( " + cond + ") {", -1)
	    break

	  case OPCODES.ELSE:
	    // XXX TODO: need to sanity-check that the `if` branch
	    // left precisely one value, of correct type, on the stack.
	    // The push/pop here resets stack state between the two branches.
	    var cf = popControlFlow()
	    if (cf.op !== OPCODES.IF) {
	      throw new CompileError("ELSE outside of IF")
	    }
	    if (! cf.isDead) {
	      cf.endReached = true
	    }
	    pushLine("} else {")
	    pushControlFlow(OPCODES.ELSE, cf.sig, cf.endReached)
	    break

	  case OPCODES.END:
	    if (cfStack.length === 1) {
	      // End of the entire function.
	      if (f.sig.return_types.length === 0) {
		if (cfStack[0].typeStack.length > 0) {
		  throw new CompileError("void function left something on the stack")
		}
		pushLine("return")
	      } else {
		pushLine("return " + popStackVar(f.sig.return_types[0]))
	      }
	      break DECODE
	    } else {
	      // End of a control block
	      var cf = cfStack[cfStack.length - 1]
	      if (! cf.isDead) {
		cf.endReached = true
	      } else if (cf.endReached && cf.sig !== TYPES.NONE) {
		// We're reached by a branch, but not by fall-through,
		// so there's not going to be an entry on the stack.
		// Make one.
		pushStackVar(cf.sig)
	      }
              // An if without an else always reaches the end of the block.
              if (cf.op === OPCODES.IF) {
                cf.endReached = true
              }
	      if (cf.endReached) {
		if (cf.sig !== TYPES.NONE) {
		  var output = getStackVar(cf.sig)
		} else {
		  if (cf.typeStack.length > 0) {
		    throw new CompileError("void block left values on the stack")
		  }
		}
	      }
	      popControlFlow()
	      if (cf.sig !== TYPES.NONE && cf.endReached) {
		pushLine("  " + pushStackVar(cf.sig) + " = " + output)
	      }
	      switch (cf.op) {
		case OPCODES.BLOCK:
		  pushLine("} while(0)")
		  break
		case OPCODES.LOOP:
		  pushLine("  break " + cf.label)
		  pushLine("}")
		  break
		case OPCODES.IF:
		case OPCODES.ELSE:
		  pushLine("} } while (0)")
		  break
		default:
		  throw new CompileError("Popped an unexpected control op")
	      }
	      if (! cf.endReached) {
                markDeadCode()
	      }
	    }
	    break

	  case OPCODES.BR:
	    var depth = s.read_varuint32()
	    var cf = getBranchTarget(depth)
	    switch (cf.op) {
	      case OPCODES.BLOCK:
	      case OPCODES.IF:
	      case OPCODES.ELSE:
		cf.endReached = true
		if (cf.sig !== TYPES.NONE) {
		  var resultVar = popStackVar(cf.sig)
		  var outputVar = getBlockOutputVar(cf)
		  if (outputVar !== resultVar) {
		    pushLine(outputVar + " = " + resultVar)
		  }
		}
		pushLine("break " + cf.label)
		break
	      case 0:
		cf.endReached = true
		if (cf.sig !== TYPES.NONE) {
		  var resultVar = popStackVar(cf.sig)
		  pushLine("return " + resultVar)
		} else {
		  pushLine("return")
		}
		break
	      case OPCODES.LOOP:
		pushLine("continue " + cf.label)
		break
	      default:
		throw new CompileError("Branch to unsupported opcode")
	    }
	    markDeadCode()
	    break

	  case OPCODES.BR_IF:
	    var depth = s.read_varuint32()
	    var cf = getBranchTarget(depth)
	    switch (cf.op) {
	      case OPCODES.BLOCK:
	      case OPCODES.IF:
	      case OPCODES.ELSE:
		cf.endReached = true
		pushLine("if (" + popStackVar(TYPES.I32) + ") {")
		if (cf.sig !== TYPES.NONE) {
		  // This is left on the stack if condition is not true.
		  // XXX TODO this needs to check what's on the stack.
		  var resultVar = getStackVar(cf.sig)
		  var outputVar = getBlockOutputVar(cf)
		  if (outputVar !== resultVar) {
		    pushLine("  " + outputVar + " = " + resultVar)
		  }
		}
		pushLine("  break " + cf.label)
		pushLine("}")
		break
	      case 0:
		cf.endReached = true
		pushLine("if (" + popStackVar(TYPES.I32) + ") {")
		if (cf.sig !== TYPES.NONE) {
		  var resultVar = getStackVar(cf.sig)
		  pushLine("return " + resultVar)
		} else {
		  pushLine("return")
		}
		pushLine("}")
		break
	      case OPCODES.LOOP:
		pushLine("if (" + popStackVar(TYPES.I32) + ") { continue " + cf.label + " }")
		break
	      default:
		throw new CompileError("Branch to unsupported opcode")
	    }
	    break

	  case OPCODES.BR_TABLE:
	    // Terribly inefficient implementation of br_table
	    // using a big ol' switch statement.
	    var count = s.read_varuint32()
	    var targets = []
	    while (count > 0) {
	      targets.push(s.read_varuint32())
	      count--
	    }
	    var default_target = s.read_varuint32()
	    var default_cf = getBranchTarget(default_target)
	    pushLine("switch(" + popStackVar(TYPES.I32) + ") {")
	    // XXX TODO: typechecking that all targets accept the
	    // same result type etc.
	    var resultVar = null;
	    if (default_cf.sig !== TYPES.NONE) {
	      resultVar = popStackVar(default_cf.sig)
	    }
	    targets.forEach(function(target, targetNum) {
	      pushLine("  case " + targetNum + ":")
	      var cf = getBranchTarget(target)
	      cf.endReached = true
	      if (cf.sig !== TYPES.NONE) {
		var outputVar = getBlockOutputVar(cf)
		if (outputVar !== resultVar) {
		  pushLine("    " + outputVar + " = " + resultVar)
		}
	      }
	      switch (cf.op) {
		case OPCODES.BLOCK:
		case OPCODES.IF:
		case OPCODES.ELSE:
		  pushLine("    break " + cf.label)
		  break
		case OPCODES.LOOP:
		  pushLine("    continue " + cf.label)
		  break
		case 0:
		  pushLine("    return " + outputVar)
		  break
		default:
		  throw new CompileError("unknown branch target type")
	      }
	    })
	    pushLine("  default:")
	    if (default_cf.sig !== TYPES.NONE) {
	      var outputVar = getBlockOutputVar(default_cf)
	      if (outputVar !== resultVar) {
		pushLine("    " + outputVar + " = " + resultVar)
	      }
	    }
	    default_cf.endReached = true
	    switch (default_cf.op) {
	      case OPCODES.BLOCK:
	      case OPCODES.IF:
	      case OPCODES.ELSE:
		pushLine("    break " + default_cf.label)
		break
	      case OPCODES.LOOP:
		pushLine("    continue " + default_cf.label)
		break
	      case 0:
		pushLine("    return " + outputVar)
		break
	      default:
		throw new CompileError("unknown branch target type")
	    }
	    pushLine("}")
	    markDeadCode()
	    break

	  case OPCODES.RETURN:
	    if (f.sig.return_types.length === 0) {
	      pushLine("return")
	    } else {
	      pushLine("return " + popStackVar(f.sig.return_types[0]))
	    }
	    markDeadCode()
	    break

	  case OPCODES.CALL:
	    var index = s.read_varuint32()
	    var callSig = getFunctionSignature(index)
	    // The rightmost arg is the one on top of stack,
	    // so we have to pop them in reverse.
	    var args = new Array(callSig.param_types.length)
	    for (var i = callSig.param_types.length - 1; i >= 0; i--) {
	      args[i] = popStackVar(callSig.param_types[i])
	    }
	    var call = "F" + index + "(" + args.join(",") + ")"
	    if (callSig.return_types.length === 0) {
	      pushLine(call)
	    } else {
	      // We know there's at most one return type, for now.
              switch (callSig.return_types[0]) {
                case TYPES.I32:
                  call = call + "|0"
                  break
                /* These break our NaN boxing...
                case TYPES.F32:
                  call = "ToF32(" + call + ")"
                  break
                case TYPES.F64:
                  call = "+" + call
                  break*/
              }
	      var output = pushStackVar(callSig.return_types[0])
	      pushLine(output + " = " + call)
	    }
	    break

	  case OPCODES.CALL_INDIRECT:
	    var type_index = s.read_varuint32()
	    var table_index = s.read_varuint1()
	    if (table_index !== 0) {
	      throw new CompileError("MVP reserved-value constraint violation")
	    }
	    getTableType(table_index) // check that the table exists
	    var callSig = getTypeSignature(type_index)
	    var callIdx = popStackVar(TYPES.I32)
	    // The rightmost arg is the one on top of stack,
	    // so we have to pop them in reverse.
	    var args = new Array(callSig.param_types.length + 1)
            args[0] = callIdx
	    for (var i = callSig.param_types.length - 1; i >= 0; i--) {
	      args[i + 1] = popStackVar(callSig.param_types[i])
	    }
            // XXX TODO: in some cases we could use asmjs type-specific function tables here.
            // For now we just delegate to an externally-defined helper.
	    var call = "call_" + makeSigStr(callSig) + "(" + args.join(",") + ")"
	    if (callSig.return_types.length === 0) {
	      pushLine(call)
	    } else {
	      // We know there's at most one return type, for now.
              switch (callSig.return_types[0]) {
                case TYPES.I32:
                  call = call + "|0"
                  break
                /* These break our NaN boxing...
                case TYPES.F32:
                  call = "ToF32(" + call + ")"
                  break
                case TYPES.F64:
                  call = "+" + call
                  break*/
              }
	      var output = pushStackVar(callSig.return_types[0])
	      pushLine(output + " = " + call)
	    }
	    break

	  case OPCODES.DROP:
	    popStackVar(TYPES.UNKNOWN)
	    break

	  case OPCODES.SELECT:
	    var condVar = popStackVar(TYPES.I32)
	    var typ = peekStackType()
	    var falseVar = popStackVar(typ)
	    var trueVar = popStackVar(typ)
	    pushStackVar(typ)
	    var outputVar = getStackVar(typ)
	    pushLine(outputVar + " = " + condVar + " ? " + trueVar + ":" + falseVar)
	    break

	  case OPCODES.GET_LOCAL:
	    var index = s.read_varuint32()
	    var typ = getLocalType(index)
	    pushStackVar(typ)
	    pushLine(getStackVar(typ) + " = " + getLocalVar(index))
	    break

	  case OPCODES.SET_LOCAL:
	    var index = s.read_varuint32()
	    pushLine(getLocalVar(index) + " = " + popStackVar(getLocalType(index)))
	    break

	  case OPCODES.TEE_LOCAL:
	    var index = s.read_varuint32()
	    var typ = getLocalType(index)
	    pushLine(getLocalVar(index) + " = " + popStackVar(typ))
	    pushStackVar(typ) // this var will already contain the value we just set
	    break

	  case OPCODES.GET_GLOBAL:
	    var index = s.read_varuint32()
	    var typ = getGlobalType(index)
	    pushStackVar(typ)
	    pushLine(getStackVar(typ) + " = " + getGlobalVar(index, typ))
	    break

	  case OPCODES.SET_GLOBAL:
	    var index = s.read_varuint32()
	    var typ = getGlobalType(index)
	    checkGlobalMutable(index)
	    pushLine(getGlobalVar(index, typ) + " = " + popStackVar(typ))
	    break

	  case OPCODES.I32_LOAD:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 4)
	    switch (flags) {
	      case 0:
	      case 1:
		i32_load_unaligned(addr, offset)
		break
	      case 2:
		i32_load_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.I64_LOAD:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    // Need two i32 vars, so create a temp one.
	    pushStackVar(TYPES.I32)
	    var addrDup = popStackVar(TYPES.I32)
	    var addr = popStackVar(TYPES.I32)
	    pushLine(addrDup + " = " + addr)
	    boundsCheck(addr, offset, 8)
	    switch (flags) {
	      case 0:
	      case 1:
		i32_load_unaligned(addr, offset)
		i32_load_unaligned(addrDup, offset + 4)
		break
	      case 2:
	      case 3:
		i32_load_aligned(addr, offset)
		i32_load_aligned(addrDup, offset + 4)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    i64_from_i32x2()
	    break

	  case OPCODES.F32_LOAD:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 4)
	    switch (flags) {
	      case 0:
	      case 1:
		f32_load_unaligned(addr, offset)
		break
	      case 2:
		f32_load_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.F64_LOAD:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 8)
	    switch (flags) {
	      case 0:
	      case 1:
	      case 2:
		f64_load_unaligned(addr, offset)
		break
	      case 3:
		f64_load_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags: " + flags)
	    }
	    break

	  case OPCODES.I32_LOAD8_S:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    if (flags > 0) {
	      throw new CompileError("alignment larger than natural")
	    }
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 1)
	    i32_load8_s(addr, offset)
	    break

	  case OPCODES.I32_LOAD8_U:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    if (flags > 0) {
	      throw new CompileError("alignment larger than natural")
	    }
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 1)
	    i32_load8_u(addr, offset)
	    break

	  case OPCODES.I32_LOAD16_S:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 2)
	    switch (flags) {
	      case 0:
		i32_load16_s_unaligned(addr, offset)
		break
	      case 1:
		i32_load16_s_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.I32_LOAD16_U:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 2)
	    switch (flags) {
	      case 0:
		i32_load16_u_unaligned(addr, offset)
		break
	      case 1:
		i32_load16_u_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.I64_LOAD8_S:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    if (flags > 0) {
	      throw new CompileError("alignment larger than natural")
	    }
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 1)
	    i32_load8_s(addr, offset)
	    i64_from_i32_s()
	    break

	  case OPCODES.I64_LOAD8_U:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    if (flags > 0) {
	      throw new CompileError("alignment larger than natural")
	    }
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 1)
	    i32_load8_u(addr, offset)
	    i64_from_i32_u()
	    break

	  case OPCODES.I64_LOAD16_S:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 2)
	    switch (flags) {
	      case 0:
		i32_load16_s_unaligned(addr, offset)
		break
	      case 1:
		i32_load16_s_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    i64_from_i32_s()
	    break

	  case OPCODES.I64_LOAD16_U:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 2)
	    switch (flags) {
	      case 0:
		i32_load16_u_unaligned(addr, offset)
		break
	      case 1:
		i32_load16_u_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    i64_from_i32_u()
	    break

	  case OPCODES.I64_LOAD32_S:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 4)
	    switch (flags) {
	      case 0:
	      case 1:
		i32_load_unaligned(addr, offset)
		break
	      case 2:
		i32_load_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    i64_from_i32_s()
	    break

	  case OPCODES.I64_LOAD32_U:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 4)
	    switch (flags) {
	      case 0:
	      case 1:
		i32_load_unaligned(addr, offset)
	      case 2:
		i32_load_aligned(addr, offset)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    i64_from_i32_u()
	    break

	  case OPCODES.I32_STORE:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I32)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 4)
	    switch (flags) {
	      case 0:
	      case 1:
		i32_store_unaligned(addr, offset, value)
		break
	      case 2:
		i32_store_aligned(addr, offset, value)
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.I64_STORE:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I64)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 8)
	    switch (flags) {
	      case 0:
	      case 1:
		i32_store_unaligned(addr, offset, value + ".low")
		i32_store_unaligned(addr, offset + 4, value + ".high")
		break
	      case 2:
	      case 3:
		i32_store_aligned(addr, offset, value + ".low")
		i32_store_aligned(addr, offset + 4, value + ".high")
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.F32_STORE:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.F32)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 8)
	    switch (flags) {
	      case 0:
	      case 1:
		f32_store_unaligned(addr, offset, value)
		break
	      case 2:
		f32_store_aligned(addr, offset, value)
		break
	      default:
		throw new CompileError("unsupported load flags: " + flags)
	    }
	    break

	  case OPCODES.F64_STORE:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.F64)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 8)
	    switch (flags) {
	      case 0:
	      case 1:
	      case 2:
		f64_store_unaligned(addr, offset, value)
		break
	      case 3:
		f64_store_aligned(addr, offset, value)
		break
	      default:
		throw new CompileError("unsupported load flags: " + flags)
	    }
	    break

	  case OPCODES.I32_STORE8:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    if (flags > 0) {
	      throw new CompileError("alignment larger than natural")
	    }
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I32)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 1)
	    i32_store8(addr, offset, value + " & 0xFF")
	    break

	  case OPCODES.I32_STORE16:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I32)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 2)
	    switch (flags) {
	      case 0:
		i32_store8(addr, offset + 0, "(" + value + " & 0x00FF) >>> 0")
		i32_store8(addr, offset + 1, "(" + value + " & 0xFF00) >>> 8")
		break
	      case 1:
		i32_store16(addr, offset, "(" + value + " & 0xFFFF) >>> 0")
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.I64_STORE8:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    if (flags > 0) {
	      throw new CompileError("alignment larger than natural")
	    }
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I64)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 1)
	    i32_store8(addr, offset, "(" + value + ".low) & 0xFF")
	    break

	  case OPCODES.I64_STORE16:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I64)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 2)
	    switch (flags) {
	      case 0:
		i32_store8(addr, offset + 0, "((" + value + ".low) & 0x00FF) >>> 0")
		i32_store8(addr, offset + 1, "((" + value + ".low) & 0xFF00) >>> 8")
		break
	      case 1:
		i32_store16(addr, offset, "((" + value + ".low) & 0xFFFF) >>> 0")
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.I64_STORE32:
	    getMemoryType(0)
	    var flags = s.read_varuint32()
	    var offset = s.read_varuint32()
	    var value = popStackVar(TYPES.I64)
	    var addr = popStackVar(TYPES.I32)
	    boundsCheck(addr, offset, 4)
	    switch (flags) {
	      case 0:
		i32_store8(addr, offset + 0, "((" + value + ".low) & 0x000000FF) >>> 0")
		i32_store8(addr, offset + 1, "((" + value + ".low) & 0x0000FF00) >>> 8")
		i32_store8(addr, offset + 2, "((" + value + ".low) & 0x00FF0000) >>> 16")
		i32_store8(addr, offset + 3, "((" + value + ".low) & 0xFF000000) >>> 24")
		break
	      case 1:
		i32_store16(addr, offset + 0, "((" + value + ".low) & 0x0000FFFF) >>> 0")
		i32_store16(addr, offset + 2, "((" + value + ".low) & 0xFFFF0000) >>> 16")
		break
	      case 2:
		i32_store_aligned(addr, offset, "(" + value + ".low)")
		break
	      default:
		throw new CompileError("unsupported load flags")
	    }
	    break

	  case OPCODES.CURRENT_MEMORY:
	    var mem_index = s.read_varuint1()
	    if (mem_index !== 0) {
	      throw new CompileError("only one memory in the MVP")
	    }
	    getMemoryType(mem_index)
	    pushLine(pushStackVar(TYPES.I32) + " = (memorySize / " + PAGE_SIZE + ")|0")
	    break

	  case OPCODES.GROW_MEMORY:
	    var mem_index = s.read_varuint1()
	    if (mem_index !== 0) {
	      throw new CompileError("only one memory in the MVP")
	    }
	    getMemoryType(mem_index)
	    var operand = popStackVar(TYPES.I32)
	    var res = pushStackVar(TYPES.I32)
	    pushLine(res + " = M0._grow(" + operand + ")")
	    break

	  case OPCODES.I32_CONST:
	    var val = s.read_varint32()
	    pushLine(pushStackVar(TYPES.I32) + " = " + renderJSValue(val, r.constants))
	    break

	  case OPCODES.I64_CONST:
	    var val = s.read_varint64()
	    pushLine(pushStackVar(TYPES.I64) + " = " + renderJSValue(val, r.constants))
	    break

	  case OPCODES.F32_CONST:
	    var val = s.read_float32()
	    pushLine(pushStackVar(TYPES.F32) + " = " + renderJSValue(val, r.constants))
	    break

	  case OPCODES.F64_CONST:
	    pushLine(pushStackVar(TYPES.F64) + " = " + renderJSValue(s.read_float64(), r.constants))
	    break

	  case OPCODES.I32_EQZ:
	    var operand = getStackVar(TYPES.I32)
	    pushLine(operand + " = (!(" + operand + "))|0")
	    break

	  case OPCODES.I32_EQ:
	    i32_binaryOp("==")
	    break

	  case OPCODES.I32_NE:
	    i32_binaryOp("!=")
	    break

	  case OPCODES.I32_LT_S:
	    i32_binaryOp("<")
	    break

	  case OPCODES.I32_LT_U:
	    i32_binaryOp("<", ">>>0")
	    break

	  case OPCODES.I32_GT_S:
	    i32_binaryOp(">")
	    break

	  case OPCODES.I32_GT_U:
	    i32_binaryOp(">", ">>>0")
	    break

	  case OPCODES.I32_LE_S:
	    i32_binaryOp("<=")
	    break

	  case OPCODES.I32_LE_U:
	    i32_binaryOp("<=", ">>>0")
	    break

	  case OPCODES.I32_GE_S:
	    i32_binaryOp(">=")
	    break

	  case OPCODES.I32_GE_U:
	    i32_binaryOp(">=", ">>>0")
	    break

	  case OPCODES.I64_EQZ:
	    var operand = popStackVar(TYPES.I64)
	    var result = pushStackVar(TYPES.I32)
	    pushLine(result + " = (" + operand + ".isZero())|0")
	    break

	  case OPCODES.I64_EQ:
	    i64_compareFunc("i64_eq")
	    break

	  case OPCODES.I64_NE:
	    i64_compareFunc("i64_ne")
	    break

	  case OPCODES.I64_LT_S:
	    i64_compareFunc("i64_lt_s")
	    break

	  case OPCODES.I64_LT_U:
	    i64_compareFunc("i64_lt_u")
	    break

	  case OPCODES.I64_GT_S:
	    i64_compareFunc("i64_gt_s")
	    break

	  case OPCODES.I64_GT_U:
	    i64_compareFunc("i64_gt_u")
	    break

	  case OPCODES.I64_LE_S:
	    i64_compareFunc("i64_le_s")
	    break

	  case OPCODES.I64_LE_U:
	    i64_compareFunc("i64_le_u")
	    break

	  case OPCODES.I64_GE_S:
	    i64_compareFunc("i64_ge_s")
	    break

	  case OPCODES.I64_GE_U:
	    i64_compareFunc("i64_ge_u")
	    break

	  case OPCODES.F32_EQ:
	    f32_compareOp("==")
	    break

	  case OPCODES.F32_NE:
	    f32_compareOp("!=")
	    break

	  case OPCODES.F32_LT:
	    f32_compareOp("<")
	    break

	  case OPCODES.F32_GT:
	    f32_compareOp(">")
	    break

	  case OPCODES.F32_LE:
	    f32_compareOp("<=")
	    break

	  case OPCODES.F32_GE:
	    f32_compareOp(">=")
	    break

	  case OPCODES.F64_EQ:
	    f64_compareOp("==")
	    break

	  case OPCODES.F64_NE:
	    f64_compareOp("!=")
	    break

	  case OPCODES.F64_LT:
	    f64_compareOp("<")
	    break

	  case OPCODES.F64_GT:
	    f64_compareOp(">")
	    break

	  case OPCODES.F64_LE:
	    f64_compareOp("<=")
	    break

	  case OPCODES.F64_GE:
	    f64_compareOp(">=")
	    break

	  case OPCODES.I32_CLZ:
	    i32_unaryOp("i32_clz")
	    break

	  case OPCODES.I32_CTZ:
	    i32_unaryOp("i32_ctz")
	    break

	  case OPCODES.I32_POPCNT:
	    i32_unaryOp("i32_popcnt")
	    break

	  case OPCODES.I32_ADD:
	    i32_binaryOp("+")
	    break

	  case OPCODES.I32_SUB:
	    i32_binaryOp("-")
	    break

	  case OPCODES.I32_MUL:
	    i32_binaryFunc("i32_mul")
	    break

	  case OPCODES.I32_DIV_S:
	    var rhs = getStackVar(TYPES.I32)
	    var lhs = getStackVar(TYPES.I32, 1)
	    pushLine("if (" + rhs + " == 0) { return trap('i32_div_s') }")
	    pushLine("if (" + lhs + " == INT32_MIN && " + rhs + " == -1) { return trap('i32_div_s') }")
	    i32_binaryOp("/")
	    break

	  case OPCODES.I32_DIV_U:
	    var rhs = getStackVar(TYPES.I32)
	    var lhs = getStackVar(TYPES.I32, 1)
	    pushLine("if (" + rhs + " == 0) { return trap('i32_div_u') }")
	    i32_binaryOp("/", ">>>0")
	    break

	  case OPCODES.I32_REM_S:
	    var rhs = getStackVar(TYPES.I32)
	    pushLine("if (" + rhs + " == 0) { return trap('i32_rem_s') }")
	    i32_binaryOp("%")
	    break

	  case OPCODES.I32_REM_U:
	    var rhs = getStackVar(TYPES.I32)
	    pushLine("if (" + rhs + " == 0) { return trap('i32_rem_u') }")
	    i32_binaryOp("%", ">>>0")
	    var res = getStackVar(TYPES.I32)
	    pushLine(res + " = " + res + "|0")
	    break

	  case OPCODES.I32_AND:
	    i32_binaryOp("&")
	    break

	  case OPCODES.I32_OR:
	    i32_binaryOp("|")
	    break

	  case OPCODES.I32_XOR:
	    i32_binaryOp("^")
	    break

	  case OPCODES.I32_SHL:
	    i32_binaryOp("<<")
	    break

	  case OPCODES.I32_SHR_S:
	    i32_binaryOp(">>")
	    break

	  case OPCODES.I32_SHR_U:
	    i32_binaryOp(">>>")
	    break

	  case OPCODES.I32_ROTL:
	    i32_binaryFunc("i32_rotl")
	    break

	  case OPCODES.I32_ROTR:
	    i32_binaryFunc("i32_rotr")
	    break

	  case OPCODES.I64_CLZ:
	    i64_unaryFunc("i64_clz")
	    break

	  case OPCODES.I64_CTZ:
	    i64_unaryFunc("i64_ctz")
	    break

	  case OPCODES.I64_POPCNT:
	    i64_unaryFunc("i64_popcnt")
	    break

	  case OPCODES.I64_ADD:
	    i64_binaryFunc("i64_add")
	    break

	  case OPCODES.I64_SUB:
	    i64_binaryFunc("i64_sub")
	    break

	  case OPCODES.I64_MUL:
	    i64_binaryFunc("i64_mul")
	    break

	  case OPCODES.I64_DIV_S:
	    var rhs = getStackVar(TYPES.I64)
	    var lhs = getStackVar(TYPES.I64, 1)
	    pushLine("if (" + rhs + ".isZero()) { return trap('i64_div_s') }")
	    pushLine("if (" + lhs + ".eq(Long.MIN_VALUE) && " + rhs + ".eq(Long.NEG_ONE)) { return trap('i64_div_s') }")
	    i64_binaryFunc("i64_div_s")
	    break

	  case OPCODES.I64_DIV_U:
	    var rhs = getStackVar(TYPES.I64)
	    pushLine("if (" + rhs + ".isZero()) { return trap('i64_div_u') }")
	    i64_binaryFunc("i64_div_u")
	    break

	  case OPCODES.I64_REM_S:
	    var rhs = getStackVar(TYPES.I64)
	    pushLine("if (" + rhs + ".isZero()) { return trap('i64_rem_s') }")
	    i64_binaryFunc("i64_rem_s")
	    break

	  case OPCODES.I64_REM_U:
	    var rhs = getStackVar(TYPES.I64)
	    pushLine("if (" + rhs + ".isZero()) { return trap('i64_rem_u') }")
	    i64_binaryFunc("i64_rem_u")
	    break

	  case OPCODES.I64_AND:
	    i64_binaryFunc("i64_and")
	    break

	  case OPCODES.I64_OR:
	    i64_binaryFunc("i64_or")
	    break

	  case OPCODES.I64_XOR:
	    i64_binaryFunc("i64_xor")
	    break

	  case OPCODES.I64_SHL:
	    i64_binaryFunc("i64_shl")
	    break

	  case OPCODES.I64_SHR_S:
	    i64_binaryFunc("i64_shr_s")
	    break

	  case OPCODES.I64_SHR_U:
	    i64_binaryFunc("i64_shr_u")
	    break

	  case OPCODES.I64_ROTL:
	    i64_binaryFunc("i64_rotl")
	    break

	  case OPCODES.I64_ROTR:
	    i64_binaryFunc("i64_rotr")
	    break

	  case OPCODES.F32_ABS:
	    f32_unaryOp("f32_abs")
	    break

	  case OPCODES.F32_NEG:
	    f32_unaryOp("f32_neg")
	    break

	  case OPCODES.F32_CEIL:
	    f32_unaryOp("f32_ceil")
	    break

	  case OPCODES.F32_FLOOR:
	    f32_unaryOp("f32_floor")
	    break

	  case OPCODES.F32_TRUNC:
	    f32_unaryOp("f32_trunc")
	    break

	  case OPCODES.F32_NEAREST:
	    f32_unaryOp("f32_nearest")
	    break

	  case OPCODES.F32_SQRT:
	    f32_unaryOp("f32_sqrt")
	    break

	  case OPCODES.F32_ADD:
	    f32_binaryOp("+")
	    break

	  case OPCODES.F32_SUB:
	    f32_binaryOp("-")
	    break

	  case OPCODES.F32_MUL:
	    f32_binaryOp("*")
	    break

	  case OPCODES.F32_DIV:
	    f32_binaryOp("/")
	    break

	  case OPCODES.F32_MIN:
	    f32_binaryFunc("f32_min")
	    break

	  case OPCODES.F32_MAX:
	    f32_binaryFunc("f32_max")
	    break

	  case OPCODES.F32_COPYSIGN:
	    f32_binaryFunc("f32_copysign")
	    break

	  case OPCODES.F64_ABS:
	    f64_unaryOp("f64_abs")
	    break

	  case OPCODES.F64_NEG:
	    f64_unaryOp("f64_neg")
	    break

	  case OPCODES.F64_CEIL:
	    f64_unaryOp("f64_ceil")
	    break

	  case OPCODES.F64_FLOOR:
	    f64_unaryOp("f64_floor")
	    break

	  case OPCODES.F64_TRUNC:
	    f64_unaryOp("f64_trunc")
	    break

	  case OPCODES.F64_NEAREST:
	    f64_unaryOp("f64_nearest")
	    break

	  case OPCODES.F64_SQRT:
	    f64_unaryOp("f64_sqrt")
	    break

	  case OPCODES.F64_ADD:
	    f64_binaryOp("+")
	    break

	  case OPCODES.F64_SUB:
	    f64_binaryOp("-")
	    break

	  case OPCODES.F64_MUL:
	    f64_binaryOp("*")
	    break

	  case OPCODES.F64_DIV:
	    f64_binaryOp("/")
	    break

	  case OPCODES.F64_MIN:
	    f64_binaryFunc("f64_min")
	    break

	  case OPCODES.F64_MAX:
	    f64_binaryFunc("f64_max")
	    break

	  case OPCODES.F64_COPYSIGN:
	    f64_binaryFunc("f64_copysign")
	    break

	  case OPCODES.I32_WRAP_I64:
	    var operand = popStackVar(TYPES.I64)
	    var output = pushStackVar(TYPES.I32)
	    pushLine(output + " = " + operand + ".low")
	    break

	  case OPCODES.I32_TRUNC_S_F32:
	    var operand = popStackVar(TYPES.F32)
	    var output = pushStackVar(TYPES.I32)
	    pushLine("if (" + operand + " > INT32_MAX) { return trap('i32_trunc_s') }")
	    pushLine("if (" + operand + " < INT32_MIN) { return trap('i32_trunc_s') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap() }")
	    pushLine(output + " = (" + operand + ")|0")
	    break

	  case OPCODES.I32_TRUNC_S_F64:
	    var operand = popStackVar(TYPES.F64)
	    var output = pushStackVar(TYPES.I32)
	    pushLine("if (" + operand + " > INT32_MAX) { return trap('i32_trunc_s') }")
	    pushLine("if (" + operand + " < INT32_MIN) { return trap('i32_trunc_s') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('i32_trunc_s') }")
	    pushLine(output + " = (" + operand + ")|0")
	    break

	  case OPCODES.I32_TRUNC_U_F32:
	    var operand = popStackVar(TYPES.F32)
	    var output = pushStackVar(TYPES.I32)
	    pushLine("if (" + operand + " > UINT32_MAX) { return trap('i32_trunc') }")
	    pushLine("if (" + operand + " <= -1) { return trap('i32_trunc') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('i32_trunc') }")
	    pushLine(output + " = ((" + operand + ")>>>0)|0")
	    break

	  case OPCODES.I32_TRUNC_U_F64:
	    var operand = popStackVar(TYPES.F64)
	    var output = pushStackVar(TYPES.I32)
	    pushLine("if (" + operand + " > UINT32_MAX) { return trap('i32_trunc') }")
	    pushLine("if (" + operand + " <= -1) { return trap('i32_trunc') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('i32_trunc') }")
	    pushLine(output + " = (" + operand + ")>>>0")
	    break

	  case OPCODES.I64_EXTEND_S_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.I64)
	    pushLine(output + " = Long.fromNumber(" + operand + ")")
	    break

	  case OPCODES.I64_EXTEND_U_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.I64)
	    pushLine(output + " = Long.fromNumber(" + operand + ">>>0, true).toSigned()")
	    break

	  case OPCODES.I64_TRUNC_S_F32:
	    var operand = popStackVar(TYPES.F32)
	    var output = pushStackVar(TYPES.I64)
	    // XXX TODO: I actually don't understand floating-point much at all,
	    //           right now am just hacking the tests into passing...
	    pushLine("if (" + operand + " >= 9.22337203685e+18) { return trap('i64-trunc') }")
	    pushLine("if (" + operand + " <= -9.22337313636e+18) { return trap('i64-trunc') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('i64-trunc') }")
	    pushLine(output + " = Long.fromNumber(" + operand + ")")
	    break

	  case OPCODES.I64_TRUNC_S_F64:
	    var operand = popStackVar(TYPES.F64)
	    var output = pushStackVar(TYPES.I64)
	    // XXX TODO: I actually don't understand floating-point much at all,
	    //           right now am just hacking the tests into passing...
	    pushLine("if (" + operand + " >= 9223372036854775808.0) { return trap('i64-trunc') }")
	    pushLine("if (" + operand + " <= -9223372036854777856.0) { return trap('i64-trunc') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('i64-trunc') }")
	    pushLine(output + " = Long.fromNumber(" + operand + ")")
	    break

	  case OPCODES.I64_TRUNC_U_F32:
	    var operand = popStackVar(TYPES.F32)
	    var output = pushStackVar(TYPES.I64)
	    // XXX TODO: I actually don't understand floating-point much at all,
	    //           right now am just hacking the tests into passing...
	    pushLine("if (" + operand + " >= 1.84467440737e+19) { return trap('i64-trunc') }")
	    pushLine("if (" + operand + " <= -1) { return trap('i64-trunc') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('i64-trunc') }")
	    pushLine(output + " = Long.fromNumber(" + operand + ", true).toSigned()")
	    break

	  case OPCODES.I64_TRUNC_U_F64:
	    var operand = popStackVar(TYPES.F64)
	    var output = pushStackVar(TYPES.I64)
	    // XXX TODO: I actually don't understand floating-point much at all,
	    //           right now am just hacking the tests into passing...
	    pushLine("if (" + operand + " >= 18446744073709551616.0) { return trap('too big') }")
	    pushLine("if (" + operand + " <= -1) { return trap('too small') }")
	    pushLine("if (isNaN(" + operand + ")) { return trap('NaN') }")
	    pushLine(output + " = Long.fromNumber(f64_trunc(" + operand + "), true).toSigned()")
	    break

	  case OPCODES.F32_CONVERT_S_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.F32)
	    pushLine(output + " = ToF32(" + operand + "|0)")
	    break

	  case OPCODES.F32_CONVERT_U_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.F32)
	    pushLine(output + " = ToF32(" + operand + ">>>0)")
	    break

	  case OPCODES.F32_CONVERT_S_I64:
	    var operand = popStackVar(TYPES.I64)
	    var output = pushStackVar(TYPES.F32)
	    pushLine(output + " = ToF32(" + operand + ".toNumber())")
	    break

	  case OPCODES.F32_CONVERT_U_I64:
	    var operand = popStackVar(TYPES.I64)
	    var output = pushStackVar(TYPES.F32)
	    pushLine(output + " = ToF32(" + operand + ".toUnsigned().toNumber())")
	    break

	  case OPCODES.F32_DEMOTE_F64:
	    var operand = popStackVar(TYPES.F64)
	    var output = pushStackVar(TYPES.F32)
	    pushLine(output + " = ToF32(" + operand + ")")
	    break

	  case OPCODES.F64_CONVERT_S_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.F64)
	    pushLine(output + " = +(" + operand + "|0)")
	    break

	  case OPCODES.F64_CONVERT_U_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.F64)
	    pushLine(output + " = +(" + operand + ">>>0)")
	    break

	  case OPCODES.F64_CONVERT_S_I64:
	    var operand = popStackVar(TYPES.I64)
	    var output = pushStackVar(TYPES.F64)
	    pushLine(output + " = +(" + operand + ".toNumber())")
	    break

	  case OPCODES.F64_CONVERT_U_I64:
	    var operand = popStackVar(TYPES.I64)
	    var output = pushStackVar(TYPES.F64)
	    pushLine(output + " = +(" + operand + ".toUnsigned().toNumber())")
	    break

	  case OPCODES.F64_PROMOTE_F32:
	    var operand = popStackVar(TYPES.F32)
	    var output = pushStackVar(TYPES.F64)
	    pushLine(output + " = +(" + operand + ")")
	    break

	  case OPCODES.I32_REINTERPRET_F32:
	    var operand = popStackVar(TYPES.F32)
	    var output = pushStackVar(TYPES.I32)
	    pushLine(output + " = i32_reinterpret_f32(" + operand + ")")
	    break

	  case OPCODES.I64_REINTERPRET_F64:
	    var operand = popStackVar(TYPES.F64)
	    var output = pushStackVar(TYPES.I64)
	    pushLine(output + " = i64_reinterpret_f64(" + operand + ")")
	    break

	  case OPCODES.F32_REINTERPRET_I32:
	    var operand = popStackVar(TYPES.I32)
	    var output = pushStackVar(TYPES.F32)
	    pushLine(output + " = f32_reinterpret_i32(" + operand + ")")
	    break

	  case OPCODES.F64_REINTERPRET_I64:
	    var operand = popStackVar(TYPES.I64)
	    var output = pushStackVar(TYPES.F64)
	    pushLine(output + " = f64_reinterpret_i64(" + operand + ")")
	    break

	  default:
	    throw new CompileError("unsupported opcode: 0x" + op.toString(16))
	}
      }

      ([header_lines, body_lines]).forEach(function(lines) {
        lines.forEach(function(ln) {
          r.putln(ln)
        })
      })
      r.putln("}")
      return c
    }
  }

  function parseDataSection() {
    var count = s.read_varuint32()
    while (count > 0) {
      r.datas.push(parseDataSegment())
      count--
    }
  }

  function parseDataSegment() {
    var d = {}
    d.index = s.read_varuint32()
    if (d.index !== 0) {
      throw new CompileError("MVP requires data index be zero")
    }
    // Check that it's a valid memory reference.
    getMemoryType(d.index)
    d.offset = parseInitExpr(TYPES.I32)
    var size = d.size = s.read_varuint32()
    // Render the data initializer straight away, so that we don't
    // have to hold the (potentially large) bytes object in memory.
    if (size === 0) {
      return d
    }
    r.putln("if ((", d.offset.jsexpr, " + ", size, ") > M0.buffer.byteLength) {")
    r.putln("  throw new TypeError('memory out of bounds')")
    r.putln("}")
    r.putln("var mb = new Uint8Array(M0.buffer)")
    var bytes = []
    var pos = 0
    while (size > 0) {
      bytes.push(s.read_byte())
      size--
      if (bytes.length >= 1024 || size === 0) {
        r.putln("mb.set([", bytes.join(","), "], (", d.offset.jsexpr, ") + ", pos, ")")
        pos += bytes.length
        bytes = []
      }
    }
    return d
  }

  function renderJSFooter() {
    renderAsmFuncsCreation()
    renderAsmFuncsHeader()
    renderAsmFuncsFooter()
    if (r.start !== null) {
      r.putln("funcs.F", r.start, "()")
    }
    if (r.exports.length > 0) {
      r.putln("return exports")
    } else {
      r.putln("return {}")
    }
    r.putln("})")
  }

  function getGlobalType(index) {
    if (index >= r.globals.length) {
      throw new CompileError("getGlobalType: no such global: " + index)
    }
    return r.globals[index].type.content_type
  }

  function getGlobalMutability(index) {
    if (index >= r.globals.length) {
      throw new CompileError("getGlobalMut: no such global: " + index)
    }
    return r.globals[index].type.mutability
  }

  function getTableType(index) {
    if (index >= r.tables.length) {
      throw new CompileError("no such table: " + index)
    }
    return r.tables[index]
  }

  function getMemoryType(index) {
    if (index >= r.memories.length) {
      throw new CompileError("no such memory: " + index)
    }
    return r.memories[index]
  }

  function getFunctionSignature(index) {
    if (index >= r.functions.length) {
      throw new CompileError("Invalid function index: " + index)
    }
    return getTypeSignature(r.functions[index].type)
  }

  function getTypeSignature(index) {
    if (index >= r.types.length) {
      throw new CompileError("Invalid type index: " + index)
    }
    return r.types[index]
  }

}


//
// A little helper object for reading primitive values
// out of the bytestream.  One day we might refactor this
// to support e.g. proper streaming reads, but for now
// it's just a nice abstraction.
//

function InputStream(bytes) {
  this.bytes = bytes
  this.idx = 0
}

InputStream.prototype.has_more_bytes = function has_more_bytes() {
  return (this.idx < this.bytes.length)
}

InputStream.prototype.skip_to = function skip_to(idx) {
  if (this.idx > idx) {
    throw new CompileError("read past end of section")
  }
  if (idx > this.bytes.length) {
    throw new CompileError("unepected end of bytes")
  }
  this.idx = idx
}

InputStream.prototype.read_byte = function read_byte() {
  if (this.idx >= this.bytes.length) {
    throw new CompileError("unepected end of bytes")
  }
  var b = this.bytes[this.idx++]|0
  //if (typeof b === 'undefined') {
  //  throw new CompileError("unepected end of bytes")
  //}
  return b
}

InputStream.prototype.read_bytes = function read_bytes(count) {
  var output = []
  while (count > 0) {
    output.push(String.fromCharCode(this.read_byte()))
    count--
  }
  return output.join("")
}

InputStream.prototype.read_uint8 = function read_uint8() {
  return this.read_byte()
}

InputStream.prototype.read_uint16 = function read_uint16() {
  return (this.read_byte()) |
	 (this.read_byte() << 8)
}

InputStream.prototype.read_uint32 = function read_uint32() {
  return (this.read_byte()) |
	 (this.read_byte() << 8) |
	 (this.read_byte() << 16) |
	 (this.read_byte() << 24)
}

InputStream.prototype.read_varuint1 = function read_varuint1() {
  var v = this.read_varuint32()
  // 1-bit int, no bits other than the very last should be set.
  if (v & 0xFFFFFFFE) {
    throw new CompileError("varuint1 too large")
  }
  return v
}

InputStream.prototype.read_varuint7 = function read_varuint7() {
  var v = this.read_varuint32()
  // 7-bit int, none of the higher bits should be set.
  if (v & 0xFFFFFF80) {
    throw new CompileError("varuint7 too large")
  }
  return v
}

InputStream.prototype.read_varuint32 = function read_varuint32() {
  var b = 0
  var result = 0
  var shift = 0
  do {
    if (shift > 32) {
      throw new CompileError("varuint32 too large")
    }
    b = this.read_byte()
    result = ((b & 0x7F) << shift) | result
    shift += 7
  } while (b & 0x80)
  return result >>> 0
}

InputStream.prototype.read_varint7 = function read_varint7() {
  var v = this.read_varint32()
  if (v > 63 || v < -64) {
    throw new CompileError("varint7 too large")
  }
  return v
}

InputStream.prototype.read_varint32 = function read_varint32() {
  var b = 0
  var result = 0
  var shift = 0
  do {
    if (shift > 32) {
      throw new CompileError("varuint32 too large")
    }
    b = this.read_byte()
    result = ((b & 0x7F) << shift) | result
    shift += 7
  } while (b & 0x80)
  if (b & 0x40 && shift < 32) {
    result = (-1 << shift) | result
  }
  return result
}

InputStream.prototype.read_varint64 = function read_varint64() {
  // This is a little fiddly, we have to split the loop into
  // two halves so we can read the low and high parts into
  // two separate 32-bit integers.
  var b = 0
  var low = 0
  var high = 0
  var shift = 0
  // Read the low bits first.
  // If the low bits are full, this will also ready the first few high bits.
  do {
    if (shift > 32) {
      break
    }
    b = this.read_byte()
    low = ((b & 0x7F) << shift) | low
    shift += 7
  } while (b & 0x80)
  // Did we read the full 32 low bits?
  if (shift < 32) {
    // Nope.  Need to sign-extend into both low and high.
    if (b & 0x40) {
      low = (-1 << shift) | low
      high = -1
    }
  } else {
    // Yep. The first 3 high bits will be in the already-read byte.
    shift = 3
    var high = (b & 0x7F) >> 4
    while (b & 0x80) {
      if (shift > 32) {
	throw new CompileError("varuint64 too large")
      }
      b = this.read_byte()
      high = ((b & 0x7F) << shift) | high
      shift += 7
    }
    // Sign-extend into the high bits.
    if (b & 0x40 && shift < 32) {
      high = (-1 << shift) | high
    }
  } 
  return new Long(low, high)
}

InputStream.prototype.read_float32 = function read_float32() {
  var dv = new DataView(this.bytes.buffer)
  var v = dv.getFloat32(this.idx, true)
  // XXX TODO: is it possible to preserve the signalling bit of a NaN?
  // They don't seem to round-trip properly.  For now, we box them to
  // ensure that we can read the signalling bit back later.
  if (isNaN(v)) {
    if (!(this.bytes[this.idx+2] & 0x40)) {
      // Remebmer that it was a signalling NaN.
      // This boxing will be lost when you operate on it, but
      // we can preserve it for long enough to get tests to pass.
      v = new Number(v)
      v._signalling = true
    }
  }
  this.idx += 4
  return v
}

InputStream.prototype.read_float64 = function read_float64() {
  var dv = new DataView(this.bytes.buffer)
  var v = dv.getFloat64(this.idx, true)
  this.idx += 8
  return v
}


//
// A helper class for accumulating the output of a parse.
//

function ParseResult(bytes) {
  this.buffer = new ArrayBuffer(32 * 1024)
  this.bytes = new Uint8Array(this.buffer)
  this.idx = 0
  this.lastSection = 0
  this.types = []
  this.imports = []
  this.exports = []
  this.constants = []
  this.functions = []
  this.globals = []
  this.tables = []
  this.memories = []
  this.elements = []
  this.datas = []
  this.start = null
  this.numImportedFunctions = 0
  this.numImportedGlobals = 0
  this.numExportedFunctions = 0
  this.numExportedGlobals = 0
  this.numExportedTables = 0
  this.numExportedMemories = 0
}

ParseResult.prototype.putc = function putc(c) {
  if (this.idx >= this.buffer.byteLength) {
    var newSize = this.buffer.byteLength * 2
    var newBuffer = new ArrayBuffer(newSize)
    var newBytes = new Uint8Array(newBuffer)
    newBytes.set(this.bytes)
    this.buffer = newBuffer
    this.bytes = newBytes
  } 
  this.bytes[this.idx++] = c
}

ParseResult.prototype.putstr = function putstr(s) {
  //s = s.trim()
  for (var i = 0; i < s.length; i++) {
    this.putc(s.charCodeAt(i))
  }
}

ParseResult.prototype.putln = function putln() {
  this.putstr(Array.from(arguments).join(""))
  this.putc('\n'.charCodeAt(0))
}

ParseResult.prototype.finalize = function finalize() {
  this.bytes = this.bytes.subarray(0, this.idx)
}
