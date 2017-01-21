//
// Parse WASM binary format into an in-memory representation.
//
// This is a fairly straightforward procedural parser for the WASM
// binary format.  It generates an object with the following properties:
//
//   XXX TODO: re-work this after refactoring
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
//

import Long from "long"

import stdlib from "../stdlib"
import { CompileError } from "../errors"
import { dump, stringifyJSValue, makeSigStr } from "../utils"
import {
  PAGE_SIZE,
  TYPES,
  EXTERNAL_KINDS,
  EXTERNAL_KIND_NAMES,
  SECTIONS,
  TOKENS,
  OPCODES
} from "../constants"

import translateFunctionCode from "./funcode"
import InputStream from "./input"
import TranslationResult from "./result"


// The top-level translation function.
// This takes a Uint8Array of bytes in WASM binary encoding,
// and generates a TransationResult containing equivalent javascript.

export default function translateBinaryEncoding(bytes) {

  // Take a rather arbitrary guess at the initial buffer size,
  // which will always be significantly larger than the input bytes.
  var initialOutputSize = 32 * 1024
  while (initialOutputSize < bytes.length * 5) {
    initialOutputSize *= 2
  }

  var s = new InputStream(bytes)
  var r = new TranslationResult(initialOutputSize)

  parseFileHeader(s)
  renderOuterJSHeader(r)
  translateKnownSections(s, r)
  renderOuterJSFooter(r)

  r.finalize()
  return r
}


// Functions for parsing various primitive bits of ito
// out of the input stream.

function parseValueType(s) {
  var v = s.read_varint7()
  if (v >= 0 || v < TYPES.F64) {
    throw new CompileError("Invalid value_type: " + v)
  }
  return v
}

function parseBlockType(s) {
  var v = s.read_varint7()
  if (v >= 0 || (v < TYPES.F64 && v !== TYPES.NONE)) {
    throw new CompileError("Invalid block_type: " + v)
  }
  return v
}

function parseElemType(s) {
  var v = s.read_varint7()
  if (v !== TYPES.ANYFUNC) {
    throw new CompileError("Invalid elem_type: " + v)
  }
  return v
}

function parseExternalKind(s) {
  var v = s.read_uint8()
  if (v > EXTERNAL_KINDS.GLOBAL) {
    throw new CompileError("Invalid external_kind: " + v)
  }
  return v
}

function parseFuncType(s) {
  var f = {}
  f.form = s.read_varint7()
  if (f.form !== TYPES.FUNC) {
    throw new CompileError("Invalid func_type form: " + f.form)
  }
  var param_count = s.read_varuint32()
  f.param_types = []
  while (param_count > 0) {
    f.param_types.push(parseValueType(s))
    param_count--
  }
  var return_count = s.read_varuint1()
  f.return_types = []
  while (return_count > 0) {
    f.return_types.push(parseValueType(s))
    return_count--
  }
  return f
}

function parseGlobalType(s) {
  var g = {}
  g.content_type = parseValueType(s)
  g.mutability = s.read_varuint1()
  return g
}

function parseTableType(s) {
  var t = {}
  t.element_type = parseElemType(s)
  t.limits = parseResizableLimits(s)
  return t
}

function parseMemoryType(s) {
  var m = {}
  m.limits = parseResizableLimits(s)
  if (m.limits.initial > 65536) {
    throw new CompileError("memory size great than 4GiB")
  }
  if (m.limits.maximum && m.limits.maximum > 65536) {
    throw new CompileError("memory size great than 4GiB")
  }
  return m
}

function parseResizableLimits(s) {
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

// Parse an initializer expression of the given type.
// The result will have a `jsexpr` property that can be
// inserted into the generated javascript.

function parseInitExpr(s, r, typ) {
  var e = {}
  e.op = s.read_byte()
  switch (e.op) {
    case OPCODES.I32_CONST:
      if (typ !== TYPES.I32) {
        throw new CompileError("invalid init_expr type: " + typ)
      }
      e.jsexpr = stringifyJSValue(s.read_varint32())
      break
    case OPCODES.I64_CONST:
      if (typ !== TYPES.I64) {
        throw new CompileError("invalid init_expr type: " + typ)
      }
      e.jsexpr = stringifyJSValue(s.read_varint64())
      break
    case OPCODES.F32_CONST:
      if (typ !== TYPES.F32) {
        throw new CompileError("invalid init_expr type: " + typ)
      }
      e.jsexpr = stringifyJSValue(s.read_float32())
      break
    case OPCODES.F64_CONST:
      if (typ !== TYPES.F64) {
        throw new CompileError("invalid init_expr type: " + typ)
      }
      e.jsexpr = stringifyJSValue(s.read_float64())
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
      e.jsexpr = "G" + typeToNameSuffix(typ) + index
      break
    default:
      throw new CompileError("Unsupported init expr opcode: 0x" + e.op.toString(16))
  }
  if (s.read_byte() !== OPCODES.END) {
    throw new CompileError("Unsupported init expr code")
  }
  return e
}


function parseFileHeader(s) {
  if (s.read_uint32() !== TOKENS.MAGIC_NUMBER) {
    throw new CompileError("incorrect magic number")
  }
  if (s.read_uint32() !== TOKENS.VERSION_NUMBER) {
    throw new CompileError("incorrect version number")
  }
}


//
// Functions for translating each of the known types of section
// in a WASM module declaration.
//

function translateKnownSections(s, r) {
  while (s.has_more_bytes()) {
    var id = s.read_varuint7()
    var payload_len = s.read_varuint32()
    var next_section_idx = s.idx + payload_len
    // We ignore named sections for now, but we have to parse
    // them just enough to detect well-formedness.
    if (! id) {
      var name_len = s.read_varuint32()
      s.read_bytes(name_len)
      s.skip_to(next_section_idx)
      continue
    }
    // Known sections are not allowed to appear out-of-order.
    if (id <= r.lastSection) {
      throw new CompileError("out-of-order section: " + id.toString())
    }
    translateSection(s, r, id)
    r.lastSection = id
    // There might be extra pading garbage in the section payload data,
    // so skip over to the known start of the next section.
    s.skip_to(next_section_idx)
  }
}

function translateSection(s, r, id) {
  switch (id) {
    case SECTIONS.TYPE:
      return translateTypeSection(s, r)
    case SECTIONS.IMPORT:
      return translateImportSection(s, r)
    case SECTIONS.FUNCTION:
      return translateFunctionSection(s, r)
    case SECTIONS.TABLE:
      return translateTableSection(s, r)
    case SECTIONS.MEMORY:
      return translateMemorySection(s, r)
    case SECTIONS.GLOBAL:
      return translateGlobalSection(s, r)
    case SECTIONS.EXPORT:
      return translateExportSection(s, r)
    case SECTIONS.START:
      return translateStartSection(s, r)
    case SECTIONS.ELEMENT:
      return translateElementSection(s, r)
    case SECTIONS.CODE:
      return translateCodeSection(s, r)
    case SECTIONS.DATA:
      return translateDataSection(s, r)
    default:
      throw new CompileError("unknown section code: " + id)
  }
}

//
// The "type" section is a list of all the different
// function type signatures used in the module.
// There's nothing to render for them, just gather
// them up for future reference.
//

function translateTypeSection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    r.types.push(parseFuncType(s))
    count--
  }
}

//
// The "import" section is a list of import entries
// giving the names, types etc of each import.
// Some of these get rendered into the outer JS function,
// while some are deferred until the inner asmjs function.
//

function translateImportSection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    translateImportEntry(s, r)
    count--
  }
}

function translateImportEntry(s, r) {
  var i = {}
  var module_len = s.read_varuint32()
  i.module_name = s.read_bytes(module_len)
  var field_len = s.read_varuint32()
  i.item_name = s.read_bytes(field_len)
  i.kind = parseExternalKind(s)
  switch (i.kind) {
    // Imported functions get rendered in the asmjs sub-function,
    // so just gather there definitions here.
    case EXTERNAL_KINDS.FUNCTION:
      i.type = s.read_varuint32()
      if (i.type >= r.types.length) {
        throw new CompileError("import has unknown type: " + i.type)
      }
      i.index = r.numImportedFunctions++
      i.name = "F" + i.index
      r.functions.push(i)
      break
    // Imported globals get rendered twice, in both the outer and inner
    // functions, so they can be in scope where needed while staying within
    // the rules of asmjs, which can't export globals.  Luckily imported
    // globals must be immutable.
    case EXTERNAL_KINDS.GLOBAL:
      i.type = parseGlobalType(s)
      if (i.type.mutability) {
        throw new CompileError("mutable globals cannot be imported")
      }
      i.index = r.numImportedGlobals++
      r.putln("var G", typeToNameSuffix(i.type.content_type), i.index, " = imports.G", i.index)
      r.globals.push(i)
      break
    // Imported tables and memories get rendered directly here, at the
    // start of the outer function.
    case EXTERNAL_KINDS.TABLE:
      if (r.tables.length > 0) {
        throw new CompileError("multiple tables")
      }
      i.type = parseTableType(s)
      r.putln("var T", r.tables.length, " = imports.T", r.tables.length)
      i.index = r.numImportedTables++
      r.tables.push(i.type)
      break
    case EXTERNAL_KINDS.MEMORY:
      if (r.memories.length > 0) {
        throw new CompileError("multiple memories")
      }
      i.type = parseMemoryType(s)
      r.putln("var M", r.memories.length, " = imports.M", r.memories.length)
      i.index = r.numImportedMemories++
      r.memories.push(i.type)
      break
    default:
      throw new CompileError("unknown import kind:" + i.kind)
  }
  r.imports.push(i)
}


//
// The "function" section is an array declaring the type signature
// of each function implemented in this module.  There's nothing
// to render yet, just gather them up for use when we're processing
// the "code" section.
//

function translateFunctionSection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    var f = { type: s.read_varuint32() }
    // This checks for the existence of that type.
    r.getTypeSignatureByIndex(f.type)
    f.index = r.functions.length
    f.name = "F" + f.index
    r.functions.push(f)
    count--
  }
}

//
// The "table" section is a list of Table objects to create locally.
// It's limited to at most 1 in the MVP, and while some of the code here
// is written to work with multuple tables, the generated javascript
// definitely won't.  We render them straight into the outer function.
//

function translateTableSection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    var t = parseTableType(s)
    r.putln("var T", r.tables.length, " = new WebAssembly.Table(", JSON.stringify(t.limits), ")")
    r.tables.push(t)
    count--
  }
  if (r.tables.length > 1) {
    throw new CompileError("more than one table entry")
  }
}

//
// The "memory" section is a list of Memory objects to create locally.
// It's limited to at most 1 in the MVP, and while some of the code here
// is written to work with multiple memories, the generated javascript
// definitely won't.  We render then straight into the outer function.
//

function translateMemorySection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    var m = parseMemoryType(s)
    r.putln("var M", r.memories.length, " = new WebAssembly.Memory(", JSON.stringify(m.limits), ")")
    r.memories.push(m)
    count--
  }
  if (r.memories.length > 1) {
    throw new CompileError("more than one memory entry")
  }
}

//
// The "global" section is a list of all global variables defined
// locally in the module, with their type and mutability.  We'll
// render these at the point they're needed, and in the body of
// the inner asmjs function.
//

function translateGlobalSection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    var g = parseGlobalVariable(s, r)
    r.globals.push(g)
    count--
  }
}

function parseGlobalVariable(s, r) {
  var g = {}
  g.type = parseGlobalType(s)
  g.init = parseInitExpr(s, r, g.type.content_type)
  return g
}

//
// The "export" section is an array listing the name, type and
// details of all the things that might be exported.
//

function translateExportSection(s, r) {
  // We can only render this code once we've got the function
  // objects, so create them now.  Their definitions haven't
  // been rendered yet, but will be hoisted when this code executes.
  renderAsmFuncCreation(r)
  r.putln("var exports = {}")
  var count = s.read_varuint32()
  var seenFields = {}
  while (count > 0) {
    translateExportEntry(s, r, seenFields)
    count--
  }
}

function translateExportEntry(s, r, seenFields) {
  var e = {}
  var field_len = s.read_varuint32()
  e.field = s.read_bytes(field_len)
  if (e.field in seenFields) {
    throw new CompileError("duplicate export name: " + e.field)
  }
  seenFields[e.field] = true
  e.kind = parseExternalKind(s)
  e.index = s.read_varuint32()
  var ref = "trap('invalid export')"
  switch (e.kind) {
    case EXTERNAL_KINDS.FUNCTION:
      // All functions, both imported and module-defined,
      // can be found on the `funcs` object at this point.
      if (e.index >= r.functions.length) {
        throw new CompileError("export of non-existent function")
      }
      ref = "funcs.F" + e.index
      r.numExportedFunctions++
      break
    case EXTERNAL_KINDS.GLOBAL:
      // Exported globals must be immutable, so it's safe to just
      // repeat its declaration here and in the inner asmjs function.
      // Careful though, any imported globals will already have been
      // rendered by the import section.
      var typ = r.getGlobalTypeByIndex(e.index)
      if (r.getGlobalMutabilityByIndex(e.index)) {
        throw new CompileError("mutable globals cannot be exported")
      }
      if (e.index >= r.numImportedGlobals) {
        r.putln("var G", typeToNameSuffix(typ), e.index, " = ", r.globals[e.index].init.jsexpr)
      }
      ref = "G" + typeToNameSuffix(typ) + e.index
      r.numExportedGlobals++
      break
    case EXTERNAL_KINDS.TABLE:
      // All tables are available by direct reference.
      if (e.index >= r.tables.length) {
        throw new CompileError("export of non-existent table")
      }
      ref = "T" + e.index
      r.numExportedTables++
      break
    case EXTERNAL_KINDS.MEMORY:
      // All memories are available by direct reference.
      if (e.index >= r.memories.length) {
        throw new CompileError("export of non-existent memory")
      }
      ref = "M" + e.index
      r.numExportedMemories++
      break
    default:
      throw new CompileError("unchecked export kind: " + e.kind)
  }
  r.putln("exports[", stringifyJSValue(e.field), "] = " + ref)
  r.exports.push(e)
}


//
// The "start" section just gives the index of a function
// to be run at startup.  It must have void args and return type.
// We can't actually render it at this point, because we haven't
// finished writing all the code!  So just stash it for later.
//

function translateStartSection(s, r) {
  var func_index = s.read_varuint32()
  var sig = r.getFunctionTypeSignatureByIndex(func_index)
  if (sig.param_types.length > 0) {
    throw new CompileError("start function must take no parameters")
  }
  if (sig.return_types.length > 0) {
    throw new CompileError("start function must return no results")
  }
  r.start = func_index
}

//
// The "element" section is a list of element segments, each
// of which is a list of function indices to set in a particular
// table.  We can emit bounds-checks immediately, but we mustn't
// render code to populate the table until the very end, so that
// linking errors don't leave it partially initialized.
//

function translateElementSection(s, r) {
  renderAsmFuncCreation(r)
  var count = s.read_varuint32()
  while (count > 0) {
    var e = translateElementSegment(s, r)
    count--
  }
}

function translateElementSegment(s, r) {
  var e = {}
  e.table = s.read_varuint32()
  if (e.table !== 0) {
    throw new CompileError("MVP requires elements table be zero")
  }
  // Check that it's a valid table reference.
  r.getTableTypeByIndex(e.table)
  e.offset = parseInitExpr(s, r, TYPES.I32)
  var num_elems = e.num_elems = s.read_varuint32()
  r.putln("if (", e.offset.jsexpr, " + ", num_elems, " > T", e.table, ".length) {")
  r.putln("  throw new WebAssembly.LinkError('table out-of-bounds')")
  r.putln("}")
  e.elems = []
  while (num_elems > 0) {
    var func_index = s.read_varuint32()
    r.getFunctionTypeSignatureByIndex(func_index)
    e.elems.push(func_index)
    num_elems--
  }
  r.elements.push(e)
}


//
// The "code" section is a list containing the body of each function
// defined in the module.  We enter the inner asmjs function and then
// render each item from this section in turn, hoping that we can produce
// valid asmjs.  But even if we can't, it's still valid javascript.
//
// There's so much code involved in this that it's been split out into
// a separate file, see ./funcode.js (and yes, it is in fact "fun code"...)
//

function translateCodeSection(s, r) {

  var count = s.read_varuint32()
  if (count + r.numImportedFunctions !== r.functions.length) {
    throw new CompileError("code section size different to function section size")
  }

  renderAsmFuncHeader(r)
  
  var n = r.numImportedFunctions
  while (count > 0) {
    translateFunctionBody(s, r, n)
    count--
    n++
  }

  renderAsmFuncFooter(r)
}

function translateFunctionBody(s, r, index) {
  var f = {}
  f.name = "F" + index
  f.sig = r.getFunctionTypeSignatureByIndex(index)
  f.sigStr = makeSigStr(f.sig)
  var body_size = s.read_varuint32()
  var end_of_body_idx = s.idx + body_size
  var local_count = s.read_varuint32()
  f.locals = []
  while (local_count > 0) {
    f.locals.push(parseLocalEntry(s))
    local_count--
  }
  translateFunctionCode(s, r, f)
  s.skip_to(end_of_body_idx)
  return f
}


function parseLocalEntry(s) {
  var e = {}
  e.count = s.read_varuint32()
  e.type = parseValueType(s)
  return e
}


//
// The "data" section is a list of data segments, each of which
// gives some bytes to set in one of the memories.  We render
// it directly into the outer function.
//

function translateDataSection(s, r) {
  var count = s.read_varuint32()
  while (count > 0) {
    translateDataSegment(s, r)
    count--
  }
}

function translateDataSegment(s, r) {
  var d = {}
  d.index = s.read_varuint32()
  if (d.index !== 0) {
    throw new CompileError("MVP requires data index be zero")
  }
  // Check that it's a valid memory reference.
  r.getMemoryTypeByIndex(d.index)
  d.offset = parseInitExpr(s, r, TYPES.I32)
  var size = d.size = s.read_varuint32()
  r.putln("if ((", d.offset.jsexpr, " + ", size, ") > M0.buffer.byteLength) {")
  r.putln("  throw new WebAssembly.LinkError('memory out of bounds')")
  r.putln("}")
  d.bytes = []
  while (size > 0) {
    d.bytes.push(s.read_byte())
    size--
  }
  r.datas.push(d)
}


//
// Functions that render the containing javascript "template"
// to make it ready for execution.  They don't consume anything
// from the input stream, and they might be called at different
// points during parsing, depending on what's in the module.
//


// The prologue of the outer JS function.

function renderOuterJSHeader(r) {
  if (r.hasRenderedOuterJSHeader) {
    return
  }
  r.hasRenderedOuterJSHeader = true
  r.putln("(function(WebAssembly, asmlib, imports) {")
  r.putln("const Long = WebAssembly._Long")
}

// The point at which the inner asmjs function is
// called to generate the function objects.

function renderAsmFuncCreation(r) {
  if (r.hasRenderedAsmFuncCreation) {
    return
  }
  r.hasRenderedAsmFuncCreation = true

  // We need to provide a couple of imports to the asmjs module
  // that have to be constructed dynamically.  First, a dynamic
  // call helper for each type signature in the module.

  if (r.tables.length === 1) {
    r.types.forEach(function(t) {
      var sigStr = makeSigStr(t)
      var args = ["idx"]
      for (var i = 0; i < t.param_types.length; i++) {
        args.push("a" + i)
      }
      r.putln("imports.call_", sigStr, " = function call_", sigStr, "(", args.join(","), "){")
      r.putln("  idx = idx >>> 0")
      r.putln("  var func = T0._get(idx)")
      r.putln("  if (func._wasmTypeSigStr) {")
      r.putln("    if (func._wasmTypeSigStr !== '", sigStr, "') { imports.trap('table sig') }")
      r.putln("  }")
      r.putln("  return func(", args.slice(1).join(","), ")")
      r.putln("}")
    })
  }

  // Create unaligned memory-access helpers.
  // These need to be dynamically created in order
  // to close over a reference to a DataView of the heap.

  r.memories.forEach(function(m, idx) {
    r.putln("var HDV = new DataView(M", idx, ".buffer)")
    if (m.limits.initial !== m.limits.maximum) {
      r.putln("M", idx, "._onChange(function() {")
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
    // For JS engines that canonicalize NaNs, we need to jump through
    // some hoops to preserve precise NaN bitpatterns.  We do this
    // by boxing it into a Number() and attaching the precise bit pattern
    // as integer properties on this object.
    r.putln("var f32_isNaN = imports.f32_isNaN")
    r.putln("var f64_isNaN = imports.f64_isNaN")
    r.putln("imports.f32_load_nan_bitpattern = function(v, addr) {")
    r.putln("  if (f32_isNaN(v)) {")
    r.putln("    v = new Number(v)")
    r.putln("    v._wasmBitPattern = HDV.getInt32(addr, true)")
    r.putln("  }")
    r.putln("  return v")
    r.putln("}")
    r.putln("imports.f32_store_nan_bitpattern = function(v, addr) {")
    r.putln("  if (typeof v === 'object' && v._wasmBitPattern) {")
    r.putln("    HDV.setInt32(addr, v._wasmBitPattern, true)")
    r.putln("  }")
    r.putln("}")
    r.putln("imports.f64_load_nan_bitpattern = function(v, addr) {")
    r.putln("  if (f64_isNaN(v)) {")
    r.putln("    v = new Number(v)")
    r.putln("    v._wasmBitPattern = new Long(")
    r.putln("      HDV.getInt32(addr, true),")
    r.putln("      HDV.getInt32(addr + 4, true)")
    r.putln("    )")
    r.putln("  }")
    r.putln("  return v")
    r.putln("}")
    r.putln("imports.f64_store_nan_bitpattern = function(v, addr) {")
    r.putln("  if (typeof v === 'object' && v._wasmBitPattern) {")
    r.putln("    HDV.setInt32(addr, v._wasmBitPattern.low, true)")
    r.putln("    HDV.setInt32(addr + 4, v._wasmBitPattern.high, true)")
    r.putln("  }")
    r.putln("}")
  })

  // Alright, now we can invoke the asmjs sub-function,
  // creating the function objects.

  if (r.functions.length > 0) {
    if (r.memories.length === 1) {
      r.putln("var funcs = asmfuncs(asmlib, imports, M0.buffer)")
    } else {
      r.putln("var funcs = asmfuncs(asmlib, imports)")
    }
  }

  // Type-tag each function object.
  // XXX TODO: using a string for this is *ugh*,
  // come up with something bettter.

  r.functions.forEach(function(f, idx) {
    var sigStr = makeSigStr(r.getFunctionTypeSignatureByIndex(idx))
    r.putln("funcs.", f.name, "._wasmTypeSigStr = '", sigStr, "'")
    r.putln("funcs.", f.name, "._wasmJSWrapper = null")
  })
}

// The prologue of the inner asmjs function.

function renderAsmFuncHeader(r) {
  if (r.hasRenderedAsmFuncHeader) {
    return
  }
  r.hasRenderedAsmFuncHeader = true

  // XXX TODO: if it turns out we couldn't render valid
  // asmjs, we should overwrite this string so that Firefox
  // doesn't waste its time trying to validate it.
  r.putln("function asmfuncs(stdlib, foreign, heap) {")
  r.putln("\"use asm\"")

  // Make heap views, if there's a memory.
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
            r.putln("var Gi", i.index, " = foreign.G", i.index, "|0")
            break
          case TYPES.I64:
            r.putln("var Gl", i.index, " = foreign.G", i.index)
            break
          case TYPES.F32:
            r.putln("var Gf", i.index, " = fround(foreign.G", i.index, ")")
            break
          case TYPES.F64:
            r.putln("var Gd", i.index, " = +foreign.G", i.index)
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
  r.putln("var f32_store_nan_bitpattern = foreign.f32_store_nan_bitpattern")
  r.putln("var f32_load_nan_bitpattern = foreign.f32_load_nan_bitpattern")
  r.putln("var f64_store_nan_bitpattern = foreign.f64_store_nan_bitpattern")
  r.putln("var f64_load_nan_bitpattern = foreign.f64_load_nan_bitpattern")

  // Declare all the global variables.
  // This repeats the declaration of any globals that were imported/exported,
  // but they're immutable, so whatevz.

  r.globals.forEach(function(g, idx) {
    if (idx >= r.numImportedGlobals) {
      switch (g.type.content_type) {
        case TYPES.I32:
          r.putln("var Gi", idx, " = ", g.init.jsexpr, "|0")
          break
        case TYPES.I64:
          r.putln("var Gl", idx, " = ", g.init.jsexpr)
          break
        case TYPES.F32:
          r.putln("var Gf", idx, " = fround(", g.init.jsexpr, ")")
          break
        case TYPES.F64:
          r.putln("var Gd", idx, " = +", g.init.jsexpr)
          break
      }
    }
  })

  // XXX TODO: if the there's a single, ungrowable table that's
  // neither imported nor exported, we could declare its contents
  // inline here and made the generated code faster, rather than
  // always having to use the dynamic call helpers.
}

// The epilogue of the inner asmjs function.

function renderAsmFuncFooter(r) {
  if (r.hasRenderedAsmFuncFooter) {
    return
  }
  r.hasRenderedAsmFuncFooter = true

  // We return *all* the functions from the asmjs module, so
  // that we can put them into tables etc in the outer function.
  r.putln("return {")
  r.functions.forEach(function(f, idx) {
    r.putln("  F", idx, ": F", idx, (idx === r.functions.length - 1) ? "" : ",")
  })
  r.putln("}")
  r.putln("}")
}

// The epilogue of the outer JS function.

function renderOuterJSFooter(r) {
  // Make sure we've always rendered the inner function,
  // even if there were no sections that triggered it.
  renderAsmFuncCreation(r)
  renderAsmFuncHeader(r)
  renderAsmFuncFooter(r)
  // Now that we're sure linking will succeed, initialize any tables.
  r.elements.forEach(function(e) {
    var pos = 0
    var elems = []
    for (var i = 0; i < e.elems.length; i++) {
      elems.push("funcs.F" + e.elems[i])
      if (elems.length >= 1024 || i === e.elems.length - 1) {
        r.putln("T", e.table, "._setmany((", e.offset.jsexpr, ") + ", pos, ", [", elems.join(","), "])")
        pos += elems.length
        elems = []
      }
    }
  })
  // And any data segments.
  r.datas.forEach(function(d) {
    var bytes = []
    var pos = 0
    r.putln("var mb = new Uint8Array(M0.buffer)")
    for (var i = 0; i < d.bytes.length; i++) {
      bytes.push(d.bytes[i])
      if (bytes.length >= 1024 || i === d.bytes.length - 1) {
        r.putln("mb.set([", bytes.join(","), "], (", d.offset.jsexpr, ") + ", pos, ")")
        pos += bytes.length
        bytes = []
      }
    }
  })
  // Run the start function, if specified.
  if (r.start !== null) {
    r.putln("funcs.F", r.start, "()")
  }
  // There won't be an `exports` variable if there were no exports.
  if (r.exports.length > 0) {
    r.putln("return exports")
  } else {
    r.putln("return {}")
  }
  r.putln("})")
}


function typeToNameSuffix(typ) {
  switch(typ) {
    case TYPES.I32:
      return "i"
    case TYPES.I64:
      return "l"
    case TYPES.F32:
      return "f"
    case TYPES.F64:
      return "d"
    default:
      throw new CompileError("unknown type: " + typ)
  }
}
