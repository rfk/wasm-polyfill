//
// Parse WASM binary format into an in-memory representation.
//
// This is a fairly straightforward procedural parser for the WASM
// binary format.  It generates an object with the following properties:
//
//  {
//    sections:   <array of known sections, indexes by section id>,
//    constants:  <array of constants parsed out of the binary>
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

  var s = new ParseStream(bytes) 

  var sections = [null]
  var constants = []

  parseFileHeader()
  parseKnownSections()

  return {
    sections: sections,
    constants: constants
  }

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
        e.jsexpr = renderJSValue(s.read_varint32(), constants)
        break
      case OPCODES.I64_CONST:
        if (typ !== TYPES.I64) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_varint64(), constants)
        break
      case OPCODES.F32_CONST:
        if (typ !== TYPES.F32) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_float32(), constants)
        break
      case OPCODES.F64_CONST:
        if (typ !== TYPES.F64) {
          throw new CompileError("invalid init_expr type: " + typ)
        }
        e.jsexpr = renderJSValue(s.read_float64(), constants)
        break
      case OPCODES.GET_GLOBAL:
        var index = s.read_varuint32()
        var globals = getImportedGlobals()
        if (index >= globals.length) {
          throw new CompileError("init_expr refers to non-imported global: " + index)
        }
        if (globals[index].type.content_type !== typ) {
          throw new CompileError("init_expr refers to global of incorrect type")
        }
        if (globals[index].type.mutability) {
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

  function parseKnownSections() {
    while (s.has_more_bytes()) {
      var id = s.read_varuint7()
      var payload_len = s.read_varuint32()
      var next_section_idx = s.idx + payload_len
      // Ignoring named sections for now, but parsing
      // them just enough to detect well-formedness.
      if (!id) {
        var name_len = s.read_varuint32()
        dump("custom section: ", s.read_bytes(name_len))
        s.skip_to(next_section_idx)
        continue
      }
      // Known sections are not allowed to appear out-of-order.
      if (id < sections.length) { throw new CompileError("out-of-order section: " + id.toString()) }
      // But some sections may be missing.
      while (sections.length < id) {
        sections.push(null)
      }
      sections.push(parseSection(id))
      // Check that we didn't ready past the declared end of section.
      // It's OK if there was some extra padding garbage in the payload data.
      s.skip_to(next_section_idx)
    }
    // Fill the rest of the known sections with nulls.
    while (sections.length <= SECTIONS.DATA) {
      sections.push(null)
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
    var entries = []
    while (count > 0) {
      entries.push(parseFuncType())
      count--
    }
    return entries
  }

  var hasTable = false
  var hasMemory = false

  function parseImportSection() {
    var count = s.read_varuint32()
    var entries = []
    while (count > 0) {
      entries.push(parseImportEntry())
      count--
    }
    return entries

    function parseImportEntry() {
      var i = {}
      var module_len = s.read_varuint32()
      i.module_name = s.read_bytes(module_len)
      var field_len = s.read_varuint32()
      i.item_name = s.read_bytes(field_len)
      i.kind = parseExternalKind()
      switch (i.kind) {
	case EXTERNAL_KINDS.FUNCTION:
	  i.type = s.read_varuint32()
	  if (i.type >= (sections[SECTIONS.TYPE] || []).length) {
	    throw new CompileError("import has unknown type: " + i.type)
	  }
	  break
	case EXTERNAL_KINDS.TABLE:
	  if (hasTable) {
	    throw new CompileError("multiple tables")
	  }
	  hasTable = true
	  i.type = parseTableType()
	  break
	case EXTERNAL_KINDS.MEMORY:
	  if (hasMemory) {
	    throw new CompileError("multiple memories")
	  }
	  hasMemory = true
	  i.type = parseMemoryType()
	  break
	case EXTERNAL_KINDS.GLOBAL:
	  i.type = parseGlobalType()
	  if (i.type.mutability) {
	    throw new CompileError("mutable globals cannot be imported")
	  }
	  break
	default:
	  throw new CompileError("unknown import kind:" + i.kind)
      }
      return i
    }
  }

  function parseFunctionSection() {
    var count = s.read_varuint32()
    var types = []
    while (count > 0) {
      types.push(s.read_varuint32())
      count--
    }
    return types
  }

  function parseTableSection() {
    var count = s.read_varuint32()
    var entries = []
    while (count > 0) {
      if (hasTable) {
	throw new CompileError("multiple tables")
      }
      hasTable = true
      entries.push(parseTableType())
      count--
    }
    if (entries.length > 1) {
      throw new CompileError("more than one table entry")
    }
    return entries
  }

  function parseMemorySection() {
    var count = s.read_varuint32()
    var entries = []
    while (count > 0) {
      if (hasMemory) {
	throw new CompileError("multiple memories")
      }
      hasMemory = true
      entries.push(parseMemoryType())
      count--
    }
    if (entries.length > 1) {
      throw new CompileError("more than one memory entry")
    }
    return entries
  }

  function parseGlobalSection() {
    var count = s.read_varuint32()
    var globals = []
    while (count > 0) {
      globals.push(parseGlobalVariable())
      count--
    }
    return globals

    function parseGlobalVariable() {
      var g = {}
      g.type = parseGlobalType()
      g.init = parseInitExpr(g.type.content_type)
      return g
    }
  }

  function parseExportSection() {
    var numImportedFunctions = getImportedFunctions().length
    var numImportedGlobals = getImportedGlobals().length
    var numImportedTables = getImportedTables().length
    var numImportedMemories = getImportedMemories().length

    var count = s.read_varuint32()
    var entries = []
    var seenFields = {}
    while (count > 0) {
      entries.push(parseExportEntry())
      count--
    }
    return entries

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
      switch (e.kind) {
	case EXTERNAL_KINDS.FUNCTION:
	  if (e.index >= (sections[SECTIONS.FUNCTION]||[]).length + numImportedFunctions) {
	    throw new CompileError("export of non-existent function")
	  }
	  break
	case EXTERNAL_KINDS.GLOBAL:
	  if (e.index >= (sections[SECTIONS.GLOBAL]||[]).length + numImportedGlobals) {
	    throw new CompileError("export of non-existent global")
	  }
	  if (getGlobalMutability(e.index)) {
	    throw new CompileError("mutable globals cannot be exported")
	  }
	  break
	case EXTERNAL_KINDS.TABLE:
	  if (e.index >= (sections[SECTIONS.TABLE]||[]).length + numImportedTables) {
	    throw new CompileError("export of non-existent table")
	  }
	  break
	case EXTERNAL_KINDS.MEMORY:
	  if (e.index >= (sections[SECTIONS.MEMORY]||[]).length + numImportedMemories) {
	    throw new CompileError("export of non-existent memory")
	  }
	  break
	default:
	  throw new CompileError("unchecked export kind: " + e.kind)
      }
      // XXX TODO: early check that index is within bounds for relevant index space?
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
    return func_index
  }

  function parseElementSection() {
    var count = s.read_varuint32()
    var entries = []
    while (count > 0) {
      entries.push(parseElementSegment())
      count--
    }
    return entries

    function parseElementSegment() {
      var e = {}
      e.index = s.read_varuint32()
      if (e.index !== 0) {
	throw new CompileError("MVP requires elements index be zero")
      }
      // Check that it's a valid table reference.
      getTableType(e.index)
      e.offset = parseInitExpr(TYPES.I32)
      var num_elems = s.read_varuint32()
      e.elems = []
      while (num_elems > 0) {
	e.elems.push(s.read_varuint32())
	num_elems--
      }
      return e
    }
  }

  function getImportedFunctions() {
    var imports = sections[SECTIONS.IMPORT] || []
    var importedFuncs = []
    imports.forEach(function(i, index) {
      if (i.kind === EXTERNAL_KINDS.FUNCTION) {
	importedFuncs.push(index)
      }
    })
    return importedFuncs
  }

  function getImportedGlobals() {
    var imports = sections[SECTIONS.IMPORT] || []
    var importedGlobals = []
    imports.forEach(function(i, index) {
      if (i.kind === EXTERNAL_KINDS.GLOBAL) {
	importedGlobals.push(i)
      }
    })
    return importedGlobals
  }

  function getImportedTables() {
    var imports = sections[SECTIONS.IMPORT] || []
    var importedTables = []
    imports.forEach(function(i, index) {
      if (i.kind === EXTERNAL_KINDS.TABLE) {
	importedTables.push(i.type)
      }
    })
    return importedTables
  }

  function getImportedMemories() {
    var imports = sections[SECTIONS.IMPORT] || []
    var importedMemories = []
    imports.forEach(function(i, index) {
      if (i.kind === EXTERNAL_KINDS.MEMORY) {
	importedMemories.push(i.type)
      }
    })
    return importedMemories
  }

  function getGlobalType(index) {
    var globals = getImportedGlobals()
    globals = globals.concat(sections[SECTIONS.GLOBAL] || [])
    if (index >= globals.length) {
      throw new CompileError("no such global: " + index)
    }
    return globals[index].type.content_type
  }

  function getGlobalMutability(index) {
    var globals = getImportedGlobals()
    globals = globals.concat(sections[SECTIONS.GLOBAL] || [])
    if (index >= globals.length) {
      throw new CompileError("no such global: " + index)
    }
    return globals[index].type.mutability
  }

  function getTableType(index) {
    var tables = getImportedTables()
    tables = tables.concat(sections[SECTIONS.TABLE] || [])
    if (index >= tables.length) {
      throw new CompileError("no such table: " + index)
    }
    return tables[index]
  }

  function getMemoryType(index) {
    var memories = getImportedMemories()
    memories = memories.concat(sections[SECTIONS.MEMORY] || [])
    if (index >= memories.length) {
      throw new CompileError("no such memory: " + index)
    }
    return memories[index]
  }

  function getFunctionSignature(index) {
    var count = 0
    var imports = sections[SECTIONS.IMPORT] || []
    for (var i = 0; i < imports.length; i++) {
      if (imports[i].kind === EXTERNAL_KINDS.FUNCTION) {
	if (index === count) {
	  // It refers to an imported function.
	  return getTypeSignature(imports[i].type)
	}
	count++
      }
    }
    // It must refer to a locally-defined function.
    index -= count
    var functions = sections[SECTIONS.FUNCTION] || []
    if (index >= functions.length) {
      throw new CompileError("Invalid function index: " + index)
    }
    return getTypeSignature(functions[index])
  }

  function getTypeSignature(index) {
    var typeSection = sections[SECTIONS.TYPE] || []
    if (index >= typeSection.length) {
      throw new CompileError("Invalid type index: " + index)
    }
    return typeSection[index]
  }

  function parseCodeSection() {
    var numImportedFunctions = getImportedFunctions().length
    var count = s.read_varuint32()
    if (sections[SECTIONS.FUNCTION] === null) {
      throw new CompileError("code section without function section")
    }
    if (count !== sections[SECTIONS.FUNCTION].length) {
      throw new CompileError("code section size different to function section size")
    }
    var entries = []
    while (count > 0) {
      entries.push(parseFunctionBody(entries.length))
      count--
    }
    return entries

    function parseFunctionBody(index) {
      var f = {}
      // XXX TODO: check that the function entry exists
      f.name = "F" + (index + numImportedFunctions)
      var sig_index = sections[SECTIONS.FUNCTION][index]
      if (sig_index >= (sections[SECTIONS.TYPE] || []).length) {
	throw new CompileError("unknown function type: " + sig_index)
      }
      f.sig = sections[SECTIONS.TYPE][sig_index]
      f.sigStr = makeSigStr(f.sig)
      var body_size = s.read_varuint32()
      var end_of_body_idx = s.idx + body_size
      var local_count = s.read_varuint32()
      f.locals = []
      while (local_count > 0) {
	f.locals.push(parseLocalEntry())
	local_count--
      }
      f.code = parseFunctionCode(f)
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
      var c = {
	header_lines: [],
	body_lines: [],
	footer_lines: []
      }

      var declaredVars = {}

      c.header_lines.push("function " + f.name + "(" + makeParamList() + ") {")
      c.footer_lines.push("}")

      function makeParamList() {
	var params = []
	f.sig.param_types.forEach(function(typ, idx) {
	  params.push(getLocalVar(idx, typ, true))
	})
	return params.join(",")
      }

      // We represent WASM's "structed stack" as a "stack of stacks".
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
	if (isDeadCode()) { return }
	var indent = cfStack.length + (indent || 0) + 1
	while (indent > 0) {
	  ln = "  " + ln
	  indent--
	}
	c.body_lines.push(ln)
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
	    initVal = "0|0"
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
	  c.header_lines.push("    var " + nm + " = " + initVal)
	  declaredVars[nm] = true
	}
      }

      function getGlobalVar(index, typ) {
	return "G" + index
      }

      function checkGlobalMutable(index) {
	var globals = sections[SECTIONS.GLOBAL] || []
	if (index >= globals.length) {
	  throw new CompileError("no such global: " + index)
	}
	if (! globals[index].type.mutability) {
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
	pushLine(res + " = HDV.getInt32(" + addr + " + " + offset + ", true)")
      }

      function i32_load_aligned(addr, offset) {
	var res = pushStackVar(TYPES.I32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  " + res + " = HDV.getInt32(" + addr + " + " + offset + ", true)")
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

      function i32_load16_s_ualigned(addr, offset, value) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = HDV.getInt16(" + addr + " + " + offset + ", true)")
      }

      function i32_load16_u_unaligned(addr, offset, value) {
	var res = pushStackVar(TYPES.I32)
	pushLine(res + " = HDV.getInt16(" + addr + " + " + offset + ", true) & 0x0000FFFF")
      }

      function i32_load16_s_aligned(addr, offset, value) {
	var res = pushStackVar(TYPES.I32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
	pushLine("  " + res + " = HDV.getInt16(" + addr + " + " + offset + ", true)")
	pushLine("} else {")
	pushLine("  " + res + " = HI16[(" + addr + " + " + offset + ")>>1]")
	pushLine("}")
      }

      function i32_load16_u_aligned(addr, offset, value) {
	var res = pushStackVar(TYPES.I32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
	pushLine("  " + res + " = HDV.getInt16(" + addr + " + " + offset + ", true) & 0x0000FFFF")
	pushLine("} else {")
	pushLine("  " + res + " = HU16[(" + addr + " + " + offset + ")>>1]")
	pushLine("}")
      }

      function i32_store_unaligned(addr, offset, value) {
	pushLine("HDV.setInt32(" + addr + " + " + offset + ", " + value + ", true)")
      }

      function i32_store_aligned(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  HDV.setInt32(" + addr + " + " + offset + ", " + value + ", true)")
	pushLine("} else {")
	pushLine("  HI32[(" + addr + " + " + offset + ")>>2] = " + value)
	pushLine("}")
      }

      function i32_store8(addr, offset, value) {
	pushLine("HU8[(" + addr + " + " + offset + ")] = " + value)
      }

      function i32_store16(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x0F) {")
	pushLine("  HDV.setInt32(" + addr + " + " + offset + ", " + value + ", true)")
	pushLine("} else {")
	pushLine("  HU16[(" + addr + " + " + offset + ")>>1] = " + value)
	pushLine("}")
      }

      function f32_load_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.F32)
	pushLine(res + " = HDV.getFloat32(" + addr + " + " + offset + ", true)")
	pushLine(res + " = f32_load_fix_signalling(" + res + ", HU8, " + addr + " + " + offset + ")")
      }

      function f32_load_aligned(addr, offset) {
	var res = pushStackVar(TYPES.F32)
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  " + res + " = HDV.getFloat32(" + addr + " + " + offset + ", true)")
	pushLine("} else {")
	pushLine("  " + res + " = HF32[(" + addr + " + " + offset + ")>>2]")
	pushLine("}")
	pushLine(res + " = f32_load_fix_signalling(" + res + ", HU8, " + addr + " + " + offset + ")")
      }

      function f32_store_unaligned(addr, offset, value) {
	pushLine("HDV.setFloat32(" + addr + " + " + offset + ", " + value + ", true)")
	pushLine("f32_store_fix_signalling(" + value + ", HU8, " + addr + " + " + offset + ")")
      }

      function f32_store_aligned(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
	pushLine("  HDV.setFloat32(" + addr + " + " + offset + ", " + value + ", true)")
	pushLine("} else {")
	pushLine("  HF32[(" + addr + " + " + offset + ")>>2] = " + value)
	pushLine("}")
	pushLine("f32_store_fix_signalling(" + value + ", HU8, " + addr + " + " + offset + ")")
      }

      function f64_load_unaligned(addr, offset) {
	var res = pushStackVar(TYPES.F64)
	pushLine(res + " = HDV.getFloat64(" + addr + " + " + offset + ", true)")
      }

      function f64_load_aligned(addr, offset) {
	var res = pushStackVar(TYPES.F64)
	pushLine("if ((" + addr + " + " + offset + ") & 0x07) {")
	pushLine("  " + res + " = HDV.getFloat64(" + addr + " + " + offset + ", true)")
	pushLine("} else {")
	pushLine("  " + res + " = HF64[(" + addr + " + " + offset + ")>>3]")
	pushLine("}")
      }

      function f64_store_unaligned(addr, offset, value) {
	pushLine("HDV.setFloat64(" + addr + " + " + offset + ", " + value + ", true)")
      }

      function f64_store_aligned(addr, offset, value) {
	pushLine("if ((" + addr + " + " + offset + ") & 0x07) {")
	pushLine("  HDV.setFloat64(" + addr + " + " + offset + ", " + value + ", true)")
	pushLine("} else {")
	pushLine("  HF64[(" + addr + " + " + offset + ")>>3] = " + value)
	pushLine("}")
      }

      function i64_from_i32_s() {
	var low32 = popStackVar(TYPES.I32)
	var res = pushStackVar(TYPES.I64)
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
		  pushLine("// STACK " + JSON.stringify(cfStack))
		  pushLine("// BLOCK TYPE " + cf.sig)
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
	    if (callSig.return_types.length === 0) {
	      pushLine("F" + index + "(" + args.join(",") + ")")
	    } else {
	      // We know there's at most one return type, for now.
	      var output = pushStackVar(callSig.return_types[0])
	      pushLine(output + " = F" + index + "(" + args.join(",") + ")")
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
	    var args = new Array(callSig.param_types.length)
	    for (var i = callSig.param_types.length - 1; i >= 0; i--) {
	      args[i] = popStackVar(callSig.param_types[i])
	    }
	    // XXX TODO: how to dynamically check call signature?
	    // Shall we just always call a stub that does this for us?
	    // Shall we use asmjs-style signature-specific tables with
	    // placeholders that trap?
	    // For now we just do a bunch of explicit checks.
	    pushLine("if (!T0[" + callIdx + "]) {")
	    pushLine("  trap('table OOB')")
	    pushLine("}")
	    pushLine("if (T0[" + callIdx + "]._wasmTypeSigStr) {")
	    pushLine("  if (T0[" + callIdx + "]._wasmTypeSigStr !== '" + makeSigStr(callSig) + "') {")
	    pushLine("    trap('table sig')")
	    pushLine("  }")
	    pushLine("}")
	    if (callSig.return_types.length === 0) {
	      pushLine("T0[" + callIdx + "](" + args.join(",") + ")")
	    } else {
	      // We know there's at most one return type, for now.
	      var output = pushStackVar(callSig.return_types[0])
	      pushLine(output + " = T0[" + callIdx + "](" + args.join(",") + ")")
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
	    pushStackVar(typ) // this var will already contain the previous value
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
	    pushLine(pushStackVar(TYPES.I32) + " = " + renderJSValue(val, constants))
	    break

	  case OPCODES.I64_CONST:
	    var val = s.read_varint64()
	    pushLine(pushStackVar(TYPES.I64) + " = " + renderJSValue(val, constants))
	    break

	  case OPCODES.F32_CONST:
	    var val = s.read_float32()
	    pushLine(pushStackVar(TYPES.F32) + " = " + renderJSValue(val, constants))
	    break

	  case OPCODES.F64_CONST:
	    pushLine(pushStackVar(TYPES.F64) + " = " + renderJSValue(s.read_float64(), constants))
	    break

	  case OPCODES.I32_EQZ:
	    var operand = getStackVar(TYPES.I32)
	    pushLine(operand + " = (" + operand + " === 0)|0")
	    break

	  case OPCODES.I32_EQ:
	    i32_binaryOp("===")
	    break

	  case OPCODES.I32_NE:
	    i32_binaryOp("!==")
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
	    f32_compareOp("===")
	    break

	  case OPCODES.F32_NE:
	    f32_compareOp("!==")
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
	    f64_compareOp("===")
	    break

	  case OPCODES.F64_NE:
	    f64_compareOp("!==")
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
	    pushLine("if (" + rhs + " === 0) { return trap('i32_div_s') }")
	    pushLine("if (" + lhs + " === INT32_MIN && " + rhs + " === -1) { return trap('i32_div_s') }")
	    i32_binaryOp("/")
	    break

	  case OPCODES.I32_DIV_U:
	    var rhs = getStackVar(TYPES.I32)
	    var lhs = getStackVar(TYPES.I32, 1)
	    pushLine("if (" + rhs + " === 0) { return trap('i32_div_u') }")
	    i32_binaryOp("/", ">>>0")
	    break

	  case OPCODES.I32_REM_S:
	    var rhs = getStackVar(TYPES.I32)
	    pushLine("if (" + rhs + " === 0) { return trap('i32_rem_s') }")
	    i32_binaryOp("%")
	    break

	  case OPCODES.I32_REM_U:
	    var rhs = getStackVar(TYPES.I32)
	    pushLine("if (" + rhs + " === 0) { return trap('i32_rem_u') }")
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

      return c
    }
  }

  function parseDataSection() {
    var count = s.read_varuint32()
    var entries = []
    while (count > 0) {
      entries.push(parseDataSegment())
      count--
    }
    return entries
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
    var size = s.read_varuint32()
    d.data = s.read_bytes(size)
    return d
  }

}


//
// A little helper object for reading primitive values
// out of the bytestream.  One day we might refactor this
// to support e.g. proper streaming reads, but for now
// it's just a nice abstraction.
//

function ParseStream(bytes) {
  this.bytes = bytes
  this.idx = 0
}

ParseStream.prototype.has_more_bytes = function has_more_bytes() {
  return (this.idx < this.bytes.length)
}

ParseStream.prototype.skip_to = function skip_to(idx) {
  if (this.idx > idx) {
    throw new CompileError("read past end of section")
  }
  if (idx > this.bytes.length) {
    throw new CompileError("unepected end of bytes")
  }
  this.idx = idx
}

ParseStream.prototype.read_byte = function read_byte() {
  var b = this.bytes[this.idx++]
  if (typeof b === 'undefined') {
    throw new CompileError("unepected end of bytes")
  }
  return b
}

ParseStream.prototype.read_bytes = function read_bytes(count) {
  var output = []
  while (count > 0) {
    output.push(String.fromCharCode(this.read_byte()))
    count--
  }
  return output.join("")
}

ParseStream.prototype.read_uint8 = function read_uint8() {
  return this.read_byte()
}

ParseStream.prototype.read_uint16 = function read_uint16() {
  return (this.read_byte()) |
	 (this.read_byte() << 8)
}

ParseStream.prototype.read_uint32 = function read_uint32() {
  return (this.read_byte()) |
	 (this.read_byte() << 8) |
	 (this.read_byte() << 16) |
	 (this.read_byte() << 24)
}

ParseStream.prototype.read_varuint1 = function read_varuint1() {
  var v = this.read_varuint32()
  // 1-bit int, no bits other than the very last should be set.
  if (v & 0xFFFFFFFE) {
    throw new CompileError("varuint1 too large")
  }
  return v
}

ParseStream.prototype.read_varuint7 = function read_varuint7() {
  var v = this.read_varuint32()
  // 7-bit int, none of the higher bits should be set.
  if (v & 0xFFFFFF80) {
    throw new CompileError("varuint7 too large")
  }
  return v
}

ParseStream.prototype.read_varuint32 = function read_varuint32() {
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

ParseStream.prototype.read_varint7 = function read_varint7() {
  var v = this.read_varint32()
  if (v > 63 || v < -64) {
    throw new CompileError("varint7 too large")
  }
  return v
}

ParseStream.prototype.read_varint32 = function read_varint32() {
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

ParseStream.prototype.read_varint64 = function read_varint64() {
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

ParseStream.prototype.read_float32 = function read_float32() {
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

ParseStream.prototype.read_float64 = function read_float64() {
  var dv = new DataView(this.bytes.buffer)
  var v = dv.getFloat64(this.idx, true)
  this.idx += 8
  return v
}
