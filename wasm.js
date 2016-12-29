(function(globalScope) {

  // XXX TODO: more generic polyfill for this
  var Long = require("long")

  //
  // The exports, trying to match the builtin JS API as much as possible.
  // 

  var WebAssembly =  {
    CompileError: CompileError,
    Instance: Instance,
    Memory: Memory,
    Module: Module,
    RuntimeError: RuntimeError,
    Table: Table,
    compile: compile,
    instantiate: instantiate,
    validate: validate,
    _Long: Long,
    _fromNaNBytes: _fromNaNBytes,
    _dump: dump
  }

  if (typeof module !== "undefined") {
    if (typeof module.exports !== "undefined") {
      module.exports = WebAssembly;
    }
  }

  if (globalScope && typeof globalScope.WebAssembly === "undefined")  {
    globalScope.WebAssembly = WebAssembly
  }

  function dump() {
    for (var i = 0; i < arguments.length; i++) {
      var arg = arguments[i]
      if (typeof arg === 'string') {
        process.stderr.write(arg)
      } else if (typeof arg === 'number') {
        process.stderr.write(renderJSValue(arg))
      } else {
        process.stderr.write(JSON.stringify(arg))
      }
      process.stderr.write(' ')
    }
    process.stderr.write('\n')
  }

  //
  // Custom error subclasses.
  // Nothing too unusual here.
  //

  function CompileError(message) {
    this.message = message || ""
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, CompileError);
    }
  }
  CompileError.prototype = new Error()
  CompileError.prototype.constructor = CompileError

  function RuntimeError(message) {
    this.message = message || ""
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, RuntimeError);
    }
  }
  RuntimeError.prototype = new Error()
  RuntimeError.prototype.constructor = RuntimeError


  //
  // The top-level aync helper functions.
  // For the moment they're only pretend-async but eventually
  // we might try to move some of the parsing work to a worker.
  //

  function validate(bytes) {
    try {
      new Module(bytes)
    } catch (err) {
      if (err instanceof CompileError) {
        return false
      }
      throw err
    }
    return true
  }

  function compile(bytes) {
    // XXX TODO: semantically, we should operate on a copy of bytes.
    return new Promise(function(resolve) {
      resolve(new Module(bytes))
    })
  }

  function instantiate(bytesOrModuleObjec , importObject) {
    var buf = arrayBufferFromBufferSource(bytesOrModuleObject)
    if (buf !== null) {
      return compile(buf).then(function(m) {
        return instantiate(m, importObject).then(function(i) {
          return {module: m, instance: i}
        })
      })
    }
    return new Promise(function(resolve) {
      resolve(new Instance(bytesOrModuleObject, importObject))
    })
  }

  //
  // The `Module` object.
  //
  // We try to match as closely as possible the defined semantics
  // of a native implementation, but of course it's kinda hard to
  // catch all the edge-cases.
  //

  function Module(bufferSource) {
    assertIsDefined(this)
    var bytes = new Uint8Array(arrayBufferFromBufferSource(bufferSource))
    var sections = parseBinaryEncoding(bytes)
    this._internals = {
      sections: sections,
      jsmodule: renderSectionsToJS(sections)
    }
  }

  Module.exports = function exports(moduleObject) {
    assertIsInstance(moduleObject, Module)
    var exports = moduleObject._internals.sections[SECTIONS.EXPORT] || []
    return exports.map(function(e) {
      return {
        name: e.field, // XXX TODO: convert from utf8
        kind: EXTERNAL_KIND_NAMES[e.kind]
      }
    })
  }

  Module.imports = function imports(moduleObject) {
    assertIsInstance(moduleObject, Module)
    var imports = moduleObject._internals.sections[SECTIONS.IMPORT] || []
    return imports.map(function(i) {
      return {
        name: i.field, // XXX TODO: convert from utf8
        kind: EXTERNAL_KIND_NAMES[i.kind]
      }
    })
  }

  // XXX TODO: Module needs to be cloneable.
  // How to make this so?

  //
  // The `Instance` object.
  //

  function Instance(moduleObject, importObject) {
    assertIsDefined(this)
    assertIsInstance(moduleObject, Module)
    if (typeof importObject !== "undefined") {
      if (typeof importObject !== "object") {
        throw new TypeError()
      }
    }
    // Collect, type-check and coerce the imports.
    var importDefs = moduleObject._internals.sections[SECTIONS.IMPORT] || []
    var imports = []
    importDefs.forEach(function(i) {
      var o = importObject[i.module_name]
      assertIsInstance(o, Object)
      var v = o[i.item_name]
      switch(i.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          assertIsCallable(v)
          // XXX TODO: check signature on Exported Function Exotic Object?
          // XXX TODO: create host function that does necessary type mapping
          // of args and return value.
          imports.push(v)
          break
        case EXTERNAL_KINDS.GLOBAL:
          // XXX TODO: check if i is an immutable global, TypeError if not
          assertIsType(v, "number")
          imports.push(ToWebAssemblyValue(v))
          break
        case EXTERNAL_KINDS.MEMORY:
          assertInstanceOf(v, Memory)
          imports.push(v)
          break
        case EXTERNAL_KINDS.TABLE:
          assertInstanceOf(v, Table)
          imports.push(v)
          break
        default:
          throw new RuntimeError("unexpected import kind: " + i.kind)
      }
    })
    // Instantiate the compiled javascript module, which will give us all the exports.
    this.exports = moduleObject._internals.jsmodule(imports, stdlib)
  }


  //
  // The `Memory` object.
  //
  // We do the best with can to immitate the growable memory
  // object from WASM on top of normal ArrayBuffers.
  //

  var PAGE_SIZE = 64 * 1024

  function Memory(memoryDescriptor) {
    assertIsDefined(this)
    assertIsType(memoryDescriptor, "object")
    var initial = ToNonWrappingUint32(memoryDescriptor.initial)
    var maximum = null
    if (memoryDescriptor.hasOwnProperty("maximum")) {
      maximum = ToNonWrappingUint32(memoryDescriptor.maximum)
    }
    this._internals = {
      buffer: new ArrayBuffer(initial * PAGE_SIZE),
      initial: initial,
      current: initial,
      maximum: maximum
    }
  }

  Memory.prototype.grow = function grow(delta) {
    assertIsInstance(this, Memory)
    // XXX TODO: guard against overflow?
    var oldSize = this._internals.current
    var newSize = oldSize + ToNonWrappingUint32(delta)
    if (this._internals.maximum !== null) {
      if (newSize > this._internals.maximum) {
        throw new RangeError()
      }
    }
    var newBuffer = new ArrayBuffer(newSize * PAGE_SIZE)
    // XXX TODO efficient copy of the old buffer
    notImplemented("copy from old buffer to new buffer")
    // XXX TODO: cleanly detach the old buffer
    this._internals.buffer = newBuffer
    this._internals.current = newSize
    return oldSize
  }

  Object.defineProperty(Memory.prototype, "buffer", {
    // XXX TODO: do I need to do anything to prevent ths buffer
    // from being detached by code that gets it?
    get: function() {
      assertIsInstance(this, Memory)
      return this._internals.buffer
    }
  })

  //
  // The `Table` object.
  //
  // For once this appears to be pretty straightforward...
  //

  function Table(tableDescriptor) {
    assertIsDefined(this)
    assertIsType(tableDescriptor, "object")
    var element = tableDescriptor.element
    if (element !== "anyfunc") {
      throw new TypeError()
    }
    var initial = ToNonWrappingUint32(tableDescriptor.initial)
    var maximum = null
    if (tableDescriptor.hasOwnProperty("maximum")) {
      maximum = ToNonWrappingUint32(tableDescriptor.maximum)
    }
    var values = new Array(initial)
    for (var i = 0; i < initial; i++) {
      values[i] = null
    }
    this._internals = {
      values: values,
      initial: initial,
      maximum: maximum
    }
  }

  Object.defineProperty(Table.prototype, "length", {
    get: function() {
      assertIsInstance(this, Table)
      return this._internals.values.length
    }
  })

  Table.prototype.grow = function grow(delta) {
    assertIsInstance(this, Table)
    // XXX TODO: guard against overflow?
    // XXX TODO: is it a delta in this context, like for Memory?
    var oldSize = this.length
    var newSize = oldSize + ToNonWrappingUint32(delta)
    if (this._internals.maximum !== null) {
      if (newSize > this._internals.maximum) {
        throw new RangeError()
      }
    }
    for (var i = oldSize; i < newSize; i++) {
      this._internals.values.push(null);
    }
    return oldSize
  }

  Table.prototype.get = function get(index) {
    assertIsInstance(this, Table)
    index = ToNonWrappingUint32(index)
    if (index >= this._internls.values.length) {
      throw RangeError
    }
    return this._internals.values[index]
  }

  Table.prototype.set = function set(index, value) {
    assertIsInstance(this, Table)
    index = ToNonWrappingUint32(index)
    // XXX TODO: value must be an Exported Function Exotic Object, TypeError otherwise
    if (index >= this._internls.values.length) {
      throw RangeError
    }
    // XXX TODO: we're supposed to extract the closure somehow?
    // Pretty sure that won't be necessary for a polyfill.
    this._internals.values[index] = value
  }


  //
  // Logic for parsing and validating WASM binary format.
  //
  // This is where the magic happens :-)
  // It's all pretty exploratory and ad-hoc for the moment,
  // while I figure out how I want to represent the results.
  //

  var TYPES = {
    UNKNOWN: 0x00,
    I32: -0x01,
    I64: -0x02,
    F32: -0x03,
    F64: -0x04,
    ANYFUNC: -0x10,
    FUNC: -0x20,
    NONE: -0x40
  }

  var EXTERNAL_KINDS = {
    FUNCTION: 0,
    TABLE: 1,
    MEMORY: 2,
    GLOBAL: 3
  }

  var EXTERNAL_KIND_NAMES = {
    FUNCTION: "function",
    TABLE: "table",
    MEMORY: "memory",
    GLOBAL: "global"
  }

  var SECTIONS = {
    TYPE: 1,
    IMPORT: 2,
    FUNCTION: 3,
    TABLE: 4,
    MEMORY: 5,
    GLOBAL: 6,
    EXPORT: 7,
    START: 8,
    ELEMENT: 9,
    CODE: 10,
    DATA: 11
  }

  function parseBinaryEncoding(bytes) {

    // All the lovely constants we need to know about.

    var TOKENS = {
      MAGIC_NUMBER: 0x6d736100,
      VERSION_NUMBER: 0xd
    }

    var OPCODES = {
      // Control flow
      UNREACHABLE: 0x00,
      NOP: 0x01,
      BLOCK: 0x02,
      LOOP: 0x03,
      IF: 0x04,
      ELSE: 0x05,
      END: 0x0b,
      BR: 0x0c,
      BR_IF: 0x0d,
      BR_TABLE: 0x0e,
      RETURN: 0x0f,
      // Calls
      CALL: 0x10,
      CALL_INDIRECT: 0x11,
      // Parametric operators
      DROP: 0x1a,
      SELECT: 0x1b,
      // Variable accesses
      GET_LOCAL: 0x20,
      SET_LOCAL: 0x21,
      TEE_LOCAL: 0x22,
      GET_GLOBAL: 0x23,
      SET_GLOBAL: 0x24,
      // Memory-related operators
      I32_LOAD: 0x28,
      I64_LOAD: 0x29,
      F32_LOAD: 0x2a,
      F64_LOAD: 0x2b,
      I32_LOAD8_S: 0x2c,
      I32_LOAD8_U: 0x2d,
      I32_LOAD16_S: 0x2e,
      I32_LOAD16_U: 0x2f,
      I64_LOAD8_S: 0x30,
      I64_LOAD8_U: 0x31,
      I64_LOAD16_S: 0x32,
      I64_LOAD16_U: 0x33,
      I64_LOAD32_S: 0x34,
      I64_LOAD32_U: 0x35,
      I32_STORE: 0x36,
      I64_STORE: 0x37,
      F32_STORE: 0x38,
      F64_STORE: 0x39,
      I32_STORE8: 0x3a,
      I32_STORE16: 0x3b,
      I64_STORE8: 0x3c,
      I64_STORE16: 0x3d,
      I64_STORE32: 0x3e,
      CURRENT_MEMORY: 0x3f,
      GROW_MEMORY: 0x40,
      // Constants
      I32_CONST: 0x41,
      I64_CONST: 0x42,
      F32_CONST: 0x43,
      F64_CONST: 0x44,
      // Comparison operators
      I32_EQZ: 0x45,
      I32_EQ: 0x46,
      I32_NE: 0x47,
      I32_LT_S: 0x48,
      I32_LT_U: 0x49,
      I32_GT_S: 0x4a,
      I32_GT_U: 0x4b,
      I32_LE_S: 0x4c,
      I32_LE_U: 0x4d,
      I32_GE_S: 0x4e,
      I32_GE_U: 0x4f,
      I64_EQZ: 0x50,
      I64_EQ: 0x51,
      I64_NE: 0x52,
      I64_LT_S: 0x53,
      I64_LT_U: 0x54,
      I64_GT_S: 0x55,
      I64_GT_U: 0x56,
      I64_LE_S: 0x57,
      I64_LE_U: 0x58,
      I64_GE_S: 0x59,
      I64_GE_U: 0x5a,
      F32_EQ: 0x5b,
      F32_NE: 0x5c,
      F32_LT: 0x5d,
      F32_GT: 0x5e,
      F32_LE: 0x5f,
      F32_GE: 0x60,
      F64_EQ: 0x61,
      F64_NE: 0x62,
      F64_LT: 0x63,
      F64_GT: 0x64,
      F64_LE: 0x65,
      F64_GE: 0x66,
      // Numeric operators
      I32_CLZ: 0x67,
      I32_CTZ: 0x68,
      I32_POPCNT: 0x69,
      I32_ADD: 0x6a,
      I32_SUB: 0x6b,
      I32_MUL: 0x6c,
      I32_DIV_S: 0x6d,
      I32_DIV_U: 0x6e,
      I32_REM_S: 0x6f,
      I32_REM_U: 0x70,
      I32_AND: 0x71,
      I32_OR: 0x72,
      I32_XOR: 0x73,
      I32_SHL: 0x74,
      I32_SHR_S: 0x75,
      I32_SHR_U: 0x76,
      I32_ROTL: 0x77,
      I32_ROTR: 0x78,
      I64_CLZ: 0x79,
      I64_CTZ: 0x7a,
      I64_POPCNT: 0x7b,
      I64_ADD: 0x7c,
      I64_SUB: 0x7d,
      I64_MUL: 0x7e,
      I64_DIV_S: 0x7f,
      I64_DIV_U: 0x80,
      I64_REM_S: 0x81,
      I64_REM_U: 0x82,
      I64_AND: 0x83,
      I64_OR: 0x84,
      I64_XOR: 0x85,
      I64_SHL: 0x86,
      I64_SHR_S: 0x87,
      I64_SHR_U: 0x88,
      I64_ROTL: 0x89,
      I64_ROTR: 0x8a,
      F32_ABS: 0x8b,
      F32_NEG: 0x8c,
      F32_CEIL: 0x8d,
      F32_FLOOR: 0x8e,
      F32_TRUNC: 0x8f,
      F32_NEAREST: 0x90,
      F32_SQRT: 0x91,
      F32_ADD: 0x92,
      F32_SUB: 0x93,
      F32_MUL: 0x94,
      F32_DIV: 0x95,
      F32_MIN: 0x96,
      F32_MAX: 0x97,
      F32_COPYSIGN: 0x98,
      F64_ABS: 0x99,
      F64_NEG: 0x9a,
      F64_CEIL: 0x9b,
      F64_FLOOR: 0x9c,
      F64_TRUNC: 0x9d,
      F64_NEAREST: 0x9e,
      F64_SQRT: 0x9f,
      F64_ADD: 0xa0,
      F64_SUB: 0xa1,
      F64_MUL: 0xa2,
      F64_DIV: 0xa3,
      F64_MIN: 0xa4,
      F64_MAX: 0xa5,
      F64_COPYSIGN: 0xa6,
      // Conversions
      I32_WRAP_I64: 0xa7,
      I32_TRUNC_S_F32: 0xa8,
      I32_TRUNC_U_F32: 0xa9,
      I32_TRUN_S_F64: 0xaa,
      I32_TRUNC_U_F64: 0xab,
      I64_EXTEND_S_I32: 0xac,
      I64_EXTEND_U_I32: 0xad,
      I64_TRUNC_S_F32: 0xae,
      I64_TRUNC_U_F32: 0xaf,
      I64_TRUNC_S_F64: 0xb0,
      I64_TRUNC_U_F64: 0xb1,
      F32_CONVERT_S_I32: 0xb2,
      F32_CONCERT_U_I32: 0xb3,
      F32_CONVERT_S_I64: 0xb4,
      F32_CONVERT_U_I64: 0xb5,
      F32_DEMOTE_F64: 0xb6,
      F64_CONVERT_S_I32: 0xb7,
      F64_CONVERT_U_I32: 0xb8,
      F64_CONVERT_S_I64: 0xb9,
      F64_CONVERT_U_I64: 0xba,
      F64_PROMOTE_F32: 0xbb,
      // Reinterpretations
      I32_REINTERPRET_F32: 0xbc,
      I64_REINTERPRET_F64: 0xbd,
      F32_REINTERPRET_I32: 0xb3,
      F64_REINTERPRET_I64: 0xbf
    }

    // We parse in a single forward pass,
    // this is the current position in the input bytes.

    var idx = 0;

    // The top-level: return an array of the known sections.
    // This uses a bunch of helper functions defined below.

    var sections = [null]
    parseFileHeader()
    parseKnownSections()
    return sections

    // Basic helper functions for reading primitive values,
    // and doing some type-checking etc.  You can distinguish
    // primitive-value reads by being named read_XYZ()

    function read_byte() {
      return bytes[idx++]
    }

    function read_bytes(count) {
      output = []
      while (count > 0) {
        output.push(String.fromCharCode(bytes[idx++]))
        count--
      }
      return output.join("")
    }

    function read_uint8() {
      return bytes[idx++]
    }

    function read_uint16() {
      return (bytes[idx++]) |
             (bytes[idx++] << 8)
    }

    function read_uint32() {
      return (bytes[idx++]) |
             (bytes[idx++] << 8) |
             (bytes[idx++] << 16) |
             (bytes[idx++] << 24)
    }

    function read_varuint1() {
      var v = read_varuint32()
      // 1-bit int, no bits other than the very last should be set.
      if (v & 0xFFFFFFFE) {
        throw new CompileError("varuint1 too large")
      }
      return v
    }

    function read_varuint7() {
      var v = read_varuint32()
      // 7-bit int, none of the higher bits should be set.
      if (v & 0xFFFFFF80) {
        throw new CompileError("varuint7 too large")
      }
      return v
    }

    function read_varuint32() {
      var b = 0
      var result = 0
      var shift = 0
      do {
        if (shift > 32) {
          throw new CompileError("varuint32 too large")
        }
        b = bytes[idx++]
        result = ((b & 0x7F) << shift) | result
        shift += 7
      } while (b & 0x80)
      return result >>> 0
    }

    function read_varint7() {
      var v = read_varint32()
      if (v > 63 || v < -64) {
        throw new CompileError("varint7 too large")
      }
      return v
    }

    function read_varint32() {
      var b = 0
      var result = 0
      var shift = 0
      do {
        if (shift > 32) {
          throw new CompileError("varuint32 too large")
        }
        b = bytes[idx++]
        result = ((b & 0x7F) << shift) | result
        shift += 7
      } while (b & 0x80)
      if (b & 0x40) {
        result = (-1 << shift) | result
      }
      return result
    }

    function read_varint64() {
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
        b = bytes[idx++]
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
          b = bytes[idx++]
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

    function read_f32() {
      var dv = new DataView(bytes.buffer)
      var v = dv.getFloat32(idx, true)
      idx += 4
      return v
    }

    function read_f64() {
      var dv = new DataView(bytes.buffer)
      var v = dv.getFloat64(idx, true)
      idx += 8
      return v
    }

    function read_value_type() {
      var v = read_varint7()
      if (v >= 0 || v < TYPES.F64) {
        throw new CompileError("Invalid value_type: " + v)
      }
      return v
    }

    function read_block_type() {
      var v = read_varint7()
      if (v >= 0 || (v < TYPES.F64 && v !== TYPES.NONE)) {
        throw new CompileError("Invalid block_type: " + v)
      }
      return v
    }

    function read_elem_type() {
      var v = read_varint7()
      if (v !== TYPES.ANYFUNC) {
        throw new CompileError("Invalid elem_type: " + v)
      }
      return v
    }

    function read_external_kind() {
      var v = read_uint8()
      if (v > EXTERNAL_KINDS.GLOBAL) {
        throw new CompileError("Invalid external_kind: " + v)
      }
      return v
    }

    // Structural parsing functions.
    // These read several primitive values from the stream
    // and return an object with fields  You can distinguish
    // them because they're named parseXYZ().

    function parseFuncType() {
      var f = {}
      f.form = read_varint7()
      if (f.form !== TYPES.FUNC) {
        throw new CompileError("Invalid func_type form: " + f.form)
      }
      var param_count = read_varuint32()
      f.param_types = []
      while (param_count > 0) {
        f.param_types.push(read_value_type())
        param_count--
      }
      var return_count = read_varuint1()
      f.return_types = []
      while (return_count > 0) {
        f.return_types.push(read_value_type())
        return_count--
      }
      return f
    }

    function parseGlobalType() {
      var g = {}
      g.content_type = read_value_type()
      g.mutability = read_varuint1()
      return g
    }

    function parseTableType() {
      var t = {}
      t.element_type = read_elem_type()
      t.limits = parseResizableLimits()
      return t
    }

    function parseMemoryType() {
      var m = {}
      m.limits = parseResizableLimits()
      return m
    }

    function parseResizableLimits() {
      var l = {}
      var flags = read_varuint1()
      l.initial = read_varuint32()
      if (flags) {
        l.maximum = read_varuint32()
      } else {
        l.maximum = null
      }
      return l
    }

    function parseInitExpr() {
      var e = {}
      e.op = read_byte()
      switch (e.op) {
        case OPCODES.I32_CONST:
          e.jsexpr = renderJSValue(read_varint32())
          break
        case OPCODES.GET_GLOBAL:
          e.value = read_varint32()
          var index = read_varuint32()
          e.jsexpr = "g" + index
          break
        default:
          throw new CompileError("Unsupported init expr opcode: " + e.op)
      }
      if (read_byte() !== OPCODES.END) {
        throw new CompileError("Unsupported init expr code")
      }
      return e
    }

    function parseFileHeader() {
      if (read_uint32() !== TOKENS.MAGIC_NUMBER) {
        throw new CompileError("incorrect magic number")
      }
      if (read_uint32() !== TOKENS.VERSION_NUMBER) {
        throw new CompileError("incorrect version number")
      }
    }

    function parseKnownSections() {
      while (idx < bytes.length) {
        var id = read_varuint7()
        // Ignoring named sections for now
        var payload_len = read_varuint32()
        var next_section_idx = idx + payload_len
        if (!id) {
          idx = next_section_idx
          continue
        }
        // Known sections are not allowed to appear out-of-order.
        if (id < sections.length) { throw new CompileError("out-of-order section") }
        // But some sections may be missing.
        while (sections.length < id) {
          sections.push(null)
        }
        sections.push(parseSection(id))
        // Check that we didn't ready past the declared end of section.
        // It's OK if there was some extra padding garbage in the payload data.
        if (idx > next_section_idx) {
          throw new CompileError("read past end of section")
        }
        idx = next_section_idx
      }
      while (sections.length <= SECTIONS.DATA) {
        sections.push(null)
      }
      if (idx !== bytes.length) {
        throw new CompileError("unepected end of bytes")
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
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseFuncType())
        count--
      }
      return entries
    }

    function parseImportSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseImportEntry())
        count--
      }
      return entries

      function parseImportEntry() {
        var i = {}
        var module_len = read_varuint32()
        i.module_name = read_bytes(module_len)
        var field_len = read_varuint32()
        i.item_name = read_bytes(field_len)
        i.kind = read_external_kind()
        switch (i.kind) {
          case EXTERNAL_KINDS.FUNCTION:
            i.type = read_varuint32()
            break
          case EXTERNAL_KINDS.TABLE:
            i.type = parseTableType()
            break
          case EXTERNAL_KINDS.MEMORY:
            i.type = parseMemoryType()
            break
          case EXTERNAL_KINDS.GLOBAL:
            i.type = parseGlobalType()
            break
          default:
            throw new CompileError("unknown import kind:" + i.kind)
        }
        return i
      }
    }

    function parseFunctionSection() {
      var count = read_varuint32()
      var types = []
      while (count > 0) {
        types.push(read_varuint32())
        count--
      }
      return types
    }

    function parseTableSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseTableType())
        count--
      }
      if (entries.length > 1) {
        throw new CompileError("more than one table entry")
      }
      return entries
    }

    function parseMemorySection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseMemoryType())
        count--
      }
      if (entries.length > 1) {
        throw new CompileError("more than one memory entry")
      }
      return entries
    }

    function parseGlobalSection() {
      var count = read_varuint32()
      var globals = []
      while (count > 0) {
        globals.push(parseGlobalVariable())
        count--
      }
      return globals

      function parseGlobalVariable() {
        var g = {}
        g.type = parseGlobalType()
        g.init = parseInitExpr()
        return g
      }
    }

    function parseExportSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseExportEntry())
        count--
      }
      return entries

      function parseExportEntry() {
        var e = {}
        var field_len = read_varuint32()
        e.field = read_bytes(field_len)
        e.kind = read_external_kind()
        e.index = read_varuint32()
        // XXX TODO: early check that index is within bounds for relevant index space?
        return e
      }
    }

    function parseStartSection() {
      return read_varuint32()
    }

    function parseElementSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseElementSegment())
        count--
      }
      return entries

      function parseElementSegment() {
        var e = {}
        e.index = read_varuint32()
        if (e.index !== 0) {
          throw new CompileError("MVP requires elements index be zero")
        }
        e.offset = parseInitExpr()
        // XXX TODO: check tht initExpr is i32
        var num_elems = read_varuint32()
        e.elems = []
        while (num_elems > 0) {
          e.elems.push(read_varuint32())
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
      var count = read_varuint32()
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
        f.sig = sections[SECTIONS.TYPE][sections[SECTIONS.FUNCTION][index]]
        var body_size = read_varuint32()
        var end_of_body_idx = idx + body_size
        var local_count = read_varuint32()
        f.locals = []
        while (local_count > 0) {
          f.locals.push(parseLocalEntry())
          local_count--
        }
        f.code = parseFunctionCode(f)
        if (idx > end_of_body_idx) {
          throw new CompileError("read past function body")
        }
        idx = end_of_body_idx
        return f
      }

      function parseLocalEntry() {
        var e = {}
        e.count = read_varuint32()
        e.type = read_value_type()
        return e
      }

      // OK, this is where is gets interesting.
      // We attempt to convert the WASM opcode into a corresponding
      // javascript function.  It will be asmjs-like but we're not
      // going to worry about full validating asm compliance just yet,
      // not least because that doesn't support growable memory anyway.

      function parseFunctionCode(f) {
        //try {
        var c = {
          header_lines: ["function " + f.name + "(" + makeParamList() + ") {"],
          body_lines: [],
          footer_lines: ["}"]
        }

        function makeParamList() {
          var params = []
          f.sig.param_types.forEach(function(typ, idx) {
            params.push(getLocalVar(idx, typ))
          })
          return params.join(",")
        }

        var cfStack = [{
          op: 0,
          sig: 0, // XXX TODO: use function return sig?
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
            dump(cfStack[i].polymorphic ? "*" : "-", cfStack[i].typeStack)
          }
          dump("--")
        }

        function pushControlFlow(op, sig) {
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
            polymorphic: false,
            endReached: false,
            typeStack: [],
            prevStackHeights: prevStackHeights
          })
          return cfStack[cfStack.length - 1]
        }

        function goPolymorphic() {
          var cf = cfStack[cfStack.length - 1]
          cf.polymorphic = true
          cf.typeStack = []
        }

        function popControlFlow() {
          cf = cfStack.pop()
          return cf
        }

        function pushLine(ln, indent) {
          if (deadCodeZone) { return }
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
          var stack = cfStack[cfStack.length - 1].typeStack
          if (stack.length === 0) {
            throw new CompileError("nothing on the stack")
          }
          return stack[stack.length - 1]
        }

        function popStackVar(wantType) {
          var name = getStackVar()
          var cf = cfStack[cfStack.length - 1]
          var typ = cf.typeStack.pop()
          if (wantType && typ !== wantType) {
            if (! cf.polymorphic) {
              throw new CompileError("Stack type mismatch: expected, " + wantType + ", found " + typ)
            }
            return "UNDEFINED"
          }
          return name
        }

        function getStackVar(typ, pos) {
          var cf = cfStack[cfStack.length - 1]
          var where = cf.typeStack.length - 1
          where -= (pos || 0)
          if (where < 0) {
            if (! cf.polymorphic) {
              throw new CompileError("stack access outside current block")
            }
            return "UNREACHABLE"
          }
          var typ = cf.typeStack[where]
          var height = cf.prevStackHeights[typ]
          for (var i = 0; i < where; i++) {
            if (cf.typeStack[i] === typ) {
              height += 1
            }
          }
          switch (typ) {
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
          if (which <= 0) {
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

        function getLocalVar(index, typ) {
          typ = typ || getLocalType(index)
          switch (typ) {
            case TYPES.I32:
              return "li" + index
            case TYPES.I64:
              return "ll" + index
            case TYPES.F32:
              return "lf" + index
            case TYPES.F64:
              return "ld" + index
            default:
              throw new CompileError("unexpected type of local")
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
          pushLine(pushStackVar(TYPES.I32) + " = (" + lhs + " " + what + " " + rhs + ")" + cast)
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
          pushLine(pushStackVar(TYPES.I32) + " = (" + lhs + " " + what + " " + rhs + ")|0")
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

        function heapAccess(heap, addr, offset, shift) {
          return heap + "[(" + addr + "+" + offset + ")>>" + shift + "]"
        }
 
        function boundsCheck(addr, offset, size) {
          pushLine("if (" + addr + " + " + (offset + size) + " > memorySize) { return trap() }")
        }

        function i32_load(expr) {
          var res = pushStackVar(TYPES.I32)
          pushLine(res + " = " + expr)
        }

        var deadCodeZone = false

        DECODE: while (true) {
          var op = read_byte()
          switch (op) {

            case OPCODES.UNREACHABLE:
              pushLine("return trap()")
              deadCodeZone = true
              break

            case OPCODES.NOP:
              break

            case OPCODES.BLOCK:
              var sig = read_block_type()
              var cf = pushControlFlow(op, sig)
              pushLine(cf.label + ": do {", -1)
              break

            case OPCODES.LOOP:
              var sig = read_block_type()
              var cf = pushControlFlow(op, sig)
              pushLine(cf.label + ": while (1) {", -1)
              break

            case OPCODES.IF:
              var sig = read_block_type()
              pushControlFlow(op, sig)
              pushLine("if (" + popStackVar(TYPES.I32) + ") { " + cfStack.label + ": do {", -1)
              break

            case OPCODES.ELSE:
              // XXX TODO: need to sanity-check that the `if` branch
              // left precisely one value, of correct type, on the stack.
              // The push/pop here resets stack state between the two branches.
              var cf = popControlFlow()
              if (! deadCodeZone) {
                cf.endReached = true
              }
              if (cf.op !== OPCODES.IF) {
                throw new CompileError("ELSE outside of IF")
              }
              deadCodeZone = false
              pushLine("} else {")
              pushControlFlow(cf.op, cf.sig)
              break

            case OPCODES.END:
              if (cfStack.length === 1) {
                // End of the entire function.
                deadCodeZone = false
                f.sig.return_types.forEach(function(typ) {
                  pushLine("return " + popStackVar(typ))
                })
                break DECODE
              } else {
                // End of a control block
                var cf = cfStack[cfStack.length - 1]
                if (! deadCodeZone) {
                  cf.endReached = true
                } else if (cf.endReached && cf.sig !== TYPES.NONE) {
                  // We're reached by a branch, but not by fall-through,
                  // so there's not going to be an entry on the stack.
                  // Make one.
                  pushStackVar(cf.sig)
                }
                if (cf.sig !== TYPES.NONE && cf.endReached) {
                  var output = getStackVar(cf.sig)
                } else {
                  if (cf.typeStack.length > 0) {
                    throw new CompileError("void block left values on the stack")
                  }
                }
                popControlFlow()
                deadCodeZone = false
                // Only push block result if *something* reaches the end
                // of the block.  Otherwise, we remain in dead code mode.
                if (cf.sig !== TYPES.NONE && cf.endReached) {
                  pushLine("  " + pushStackVar(cf.sig) + " = " + output)
                }
                switch (cf.op) {
                  case OPCODES.BLOCK:
                    pushLine("} while(0)")
                    break
                  case OPCODES.LOOP:
                    pushLine("}")
                    break
                  case OPCODES.IF:
                    pushLine("} while (0) }")
                    break
                  default:
                    throw new CompileError("Popped an unexpected control op")
                }
                if (! cf.endReached) {
                  goPolymorphic()
                  deadCodeZone = true
                }
              }
              break

            case OPCODES.BR:
              var depth = read_varuint32()
              var cf = getBranchTarget(depth)
              switch (cf.op) {
                case OPCODES.BLOCK:
                case OPCODES.IF:
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
                case OPCODES.LOOP:
                  pushLine("continue " + cf.label)
                  break
                default:
                  throw new CompileError("Branch to unsupported opcode")
              }
              goPolymorphic()
              deadCodeZone = true
              break

            case OPCODES.BR_IF:
              var depth = read_varuint32()
              var cf = getBranchTarget(depth)
              switch (cf.op) {
                case OPCODES.BLOCK:
                case OPCODES.IF:
                  cf.endReached = true
                  pushLine("if (" + popStackVar(TYPES.I32) + ") {")
                  if (cf.sig !== TYPES.NONE) {
                    // This is left on the stack if condition is not true.
                    var resultVar = getStackVar(cf.sig)
                    var outputVar = getBlockOutputVar(cf)
                    if (outputVar !== resultVar) {
                      pushLine("  " + outputVar + " = " + resultVar)
                    }
                  }
                  pushLine("  break " + cf.label)
                  pushLine("}")
                  break
                case OPCODES.LOOP:
                  pushLine("if (" + popStackVar(TYPES.I32) + ") continue " + cf.label)
                  break
                default:
                  throw new CompileError("Branch to unsupported opcode")
              }
              break

            case OPCODES.BR_TABLE:
              // Terribly inefficient implementation of br_table
              // using a big ol' switch statement.
              var count = read_varuint32()
              var targets = []
              while (count > 0) {
                targets.push(read_varuint32())
                count--
              }
              var default_target = read_varuint32()
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
                    pushLine("    break " + cf.label)
                    break
                  case OPCODES.LOOP:
                    pushLine("    continue " + cf.label)
                    break
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
                  pushLine("    break " + default_cf.label)
                  break
                case OPCODES.LOOP:
                  pushLine("    continue " + default_cf.label)
                  break
              }
              pushLine("}")
              goPolymorphic()
              deadCodeZone = true
              break

            case OPCODES.RETURN:
              if (f.sig.return_types.length === 0) {
                pushLine("return")
              } else {
                pushLine("return " + popStackVar(f.sig.return_types[0]))
              }
              goPolymorphic()
              deadCodeZone = true
              break

            case OPCODES.CALL:
              var index = read_varuint32()
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
              var type_index = read_varuint32()
              if (read_varuint1() !== 0) {
                throw new CompileError("MVP reserved-value constraint violation")
              }
              var callSig = getTypeSignature(type_index)
              // XXX TODO: in what order do we pop args, FIFO or LIFO?
              var args = []
              callSig.param_types.forEach(function(typ) {
                args.push(popStackVar(typ))
              })
              // XXX TODO: how to dynamically check call signature?
              // Shall we just always call a stub that does this for us?
              // Shall we use asmjs-style signature-specific tables with
              // placeholders that trap?
              pushLine("TABLE[" + popStackVar(TYPES.I32) + "](" + args.join(",") + ")")
              callSig.return_types.forEach(function(typ) {
                pushStackVar(type)
              })
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
              var outputVar = getStackVar()
              pushLine(outputVar + " = " + condVar + " ? " + trueVar + ":" + falseVar)
              break

            case OPCODES.GET_LOCAL:
              var index = read_varuint32()
              pushStackVar(getLocalType(index))
              pushLine(getStackVar() + " = " + getLocalVar(index))
              break

            case OPCODES.SET_LOCAL:
              var index = read_varuint32()
              pushLine(getLocalVar(index) + " = " + popStackVar(getLocalType(index)))
              break

            case OPCODES.TEE_LOCAL:
              var index = read_varuint32()
              var typ = getLocalType(index)
              pushLine(getLocalVar(index) + " = " + popStackVar(typ))
              pushStackVar(typ) // this var will already contain the previous value
              break

            case OPCODES.GET_GLOBAL:
              var index = read_varuint32()
              var typ = getGlobalType(index)
              pushStackVar(typ)
              pushLine(getStackVar() + " = " + getGlobalVar(index, typ))
              break

            case OPCODES.SET_GLOBAL:
              var index = read_varuint32()
              var typ = getGlobalType(index)
              pushLine(getGlobalVar(index, typ) + " = " + popStackVar(typ))
              break

            case OPCODES.I32_LOAD:
              var flags = read_varuint32()
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 4)
              switch (flags) {
                case 0:
                  // Unaligned, read four individual bytes
                  i32_load(
                    heapAccess("HU8", addr, offset, 0) + " | " +
                    "(" + heapAccess("HU8", addr, offset + 1, 0) + " << 8)" + " | " +
                    "(" + heapAccess("HU8", addr, offset + 2, 0) + " << 16)" + " | " +
                    "(" + heapAccess("HU8", addr, offset + 3, 0) + " << 24)"
                  )
                  break
                case 1:
                  // Partially aligned, read two 16-bit words
                  i32_load(
                    heapAccess("HU16", addr, offset, 1) + " | " +
                    "(" + heapAccess("HU16", addr, offset + 2, 1) + " << 16)"
                  )
                  break
                case 2:
                  // Natural alignment
                  i32_load(heapAccess("HI32", addr, offset, 2))
                  break
                default:
                  throw new CompileError("unsupported load flags")
              }
              break

            case OPCODES.I64_LOAD:
              notImplemented()
              break

            case OPCODES.F32_LOAD:
              notImplemented()
              break

            case OPCODES.F64_LOAD:
              notImplemented()
              break

            case OPCODES.I32_LOAD8_S:
              var flags = read_varuint32()
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_load(heapAccess("HI8", addr, offset, 0))
              break

            case OPCODES.I32_LOAD8_U:
              var flags = read_varuint32()
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_load(heapAccess("HU8", addr, offset, 0))
              break

            case OPCODES.I32_LOAD16_S:
              var flags = read_varuint32()
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 2)
              switch (flags) {
                case 0:
                  // Unaligned, read two individual bytes
                  i32_load(
                    heapAccess("HU8", addr, offset, 0) + " | " +
                    "(" + heapAccess("HU8", addr, offset + 1, 0) + " << 8)"
                  )
                  // Sign-extend to i32
                  var res = getStackVar(TYPES.I32)
                  pushLine("if (" + res + " & 0x8000) { " + res + " |= (-1 << 16) }")
                  break
                case 1:
                  // Natural alignment
                  i32_load(heapAccess("HI16", addr, offset, 1))
                  break
                default:
                  throw new CompileError("unsupported load flags")
              }
              break

            case OPCODES.I32_LOAD16_U:
              var flags = read_varuint32()
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 2)
              switch (flags) {
                case 0:
                  // Unaligned, read two individual bytes
                  i32_load(
                    heapAccess("HU8", addr, offset, 0) + " | " +
                    "(" + heapAccess("HU8", addr, offset + 1, 0) + " << 8)"
                  )
                  break
                case 1:
                  // Natural alignment
                  i32_load(heapAccess("HU16", addr, offset, 1))
                  break
                default:
                  throw new CompileError("unsupported load flags")
              }
              break

            case OPCODES.I32_CONST:
              pushLine(pushStackVar(TYPES.I32) + " = " + renderJSValue(read_varint32()))
              break

            case OPCODES.I64_CONST:
              var v = read_varint64()
              pushLine(pushStackVar(TYPES.I64) + " = new Long(" + v.low + "," + v.high + ")")
              break

            case OPCODES.F32_CONST:
              pushLine(pushStackVar(TYPES.F32) + " = " + renderJSValue(read_f32()))
              break

            case OPCODES.F64_CONST:
              pushLine(pushStackVar(TYPES.F64) + " = " + renderJSValue(read_f64()))
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
              pushLine("if (" + rhs + " === 0) { return trap() }")
              pushLine("if (" + lhs + " === INT32_MIN && " + rhs + " === -1) { return trap() }")
              i32_binaryOp("/")
              break

            case OPCODES.I32_DIV_U:
              var rhs = getStackVar(TYPES.I32)
              var lhs = getStackVar(TYPES.I32, 1)
              pushLine("if (" + rhs + " === 0) { return trap() }")
              i32_binaryOp("/", ">>>0")
              break

            case OPCODES.I32_REM_S:
              var rhs = getStackVar(TYPES.I32)
              pushLine("if (" + rhs + " === 0) { return trap() }")
              i32_binaryOp("%")
              break

            case OPCODES.I32_REM_U:
              var rhs = getStackVar(TYPES.I32)
              pushLine("if (" + rhs + " === 0) { return trap() }")
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
              pushLine("if (" + rhs + ".isZero()) { return trap() }")
              pushLine("if (" + lhs + ".eq(Long.MIN_VALUE) && " + rhs + ".eq(Long.NEG_ONE)) { return trap() }")
              i64_binaryFunc("i64_div_s")
              break

            case OPCODES.I64_DIV_U:
              var rhs = getStackVar(TYPES.I64)
              pushLine("if (" + rhs + ".isZero()) { return trap() }")
              i64_binaryFunc("i64_div_u")
              break

            case OPCODES.I64_REM_S:
              var rhs = getStackVar(TYPES.I64)
              pushLine("if (" + rhs + ".isZero()) { return trap() }")
              i64_binaryFunc("i64_rem_s")
              break

            case OPCODES.I64_REM_U:
              var rhs = getStackVar(TYPES.I64)
              pushLine("if (" + rhs + ".isZero()) { return trap() }")
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
              f32_unaryOp("-")
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

            case OPCODES.I32_REINTERPRET_F32:
              var operand = popStackVar(TYPES.F32)
              var output = pushStackVar(TYPES.I32)
              pushLine(output + " = ToF32(" + operand + ")|0")
              break

            case OPCODES.I64_REINTERPRET_F64:
              var operand = popStackVar(TYPES.F64)
              var output = pushStackVar(TYPES.I64)
              pushLine(output + " = i64_reinterpret_f64(" + operand + ")")
              break

            default:
              throw new CompileError("unsupported opcode: 0x" + op.toString(16))
          }
        }
        pushLine("// compiled successfully")

        return c
        //}
        //finally {
        //  dump("---") 
        //  dump(f.name)
        //  dump(c.body_lines.join("\n"))
        //  dump("---") 
        //}
      }
    }

    function parseDataSection() {
      var count = read_varuint32()
      var entries = []
      while (count > 0) {
        entries.push(parseDataSegment())
        count--
      }
      return entries
    }

    function parseDataSegment() {
      var d = {}
      d.index = read_varuint32()
      if (d.index !== 0) {
        throw new CompileError("MVP requires data index be zero")
      }
      d.offset = parseInitExpr()
      // XXX TODO: assert that initializer yields an i32
      var size = read_varuint32()
      d.data = read_bytes(size)
      return d
    }

  }

  function renderSectionsToJS(sections) {
    //dump("---- RENDERING CODE ----")
    var src = []

    // Import all the things from the stdlib.

    src.push("const Long = WebAssembly._Long")
    Object.keys(stdlib).forEach(function(key) {
      src.push("const " + key + " = stdlib." + key)
    })

    // Pull in various imports.

    var imports = sections[SECTIONS.IMPORT] || []
    var countFuncs = 0
    imports.forEach(function(i, idx) {
      switch (i.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          src.push("var F" + countFuncs + " = imports[" + idx + "]")
          countFuncs++
          break
        default:
          notImplemented()
      }
    })

    // XXX TODO: declare tables.

    var tables = sections[SECTIONS.TABLE] || []
    tables.forEach(function(t, idx) {
      notImplemented()
    })

    // Create requested memory, and provide views into it.

    var memories = sections[SECTIONS.MEMORY] || []
    memories.forEach(function(m, idx) {
      src.push("var M" + idx + " = new WebAssembly.Memory(" + JSON.stringify(m.limits) + ")")
    })

    if (memories.length > 0) {
      src.push("var memorySize = M0.buffer.byteLength")
      src.push("var HI8 = new Int8Array(M0.buffer)")
      src.push("var HI16 = new Int16Array(M0.buffer)")
      src.push("var HI32 = new Int32Array(M0.buffer)")
      src.push("var HU8 = new Uint8Array(M0.buffer)")
      src.push("var HU16 = new Uint16Array(M0.buffer)")
      src.push("var HU32 = new Uint32Array(M0.buffer)")
    }

    // XXX TODO: declare globals.

    var globals = sections[SECTIONS.GLOBAL] || []
    globals.forEach(function(g, idx) {
      notImplemented()
    })

    // Render the code for each function.

    var code = sections[SECTIONS.CODE] || []
    code.forEach(function(f, idx) {
      Array.prototype.push.apply(src, f.code.header_lines)
      Array.prototype.push.apply(src, f.code.body_lines)
      Array.prototype.push.apply(src, f.code.footer_lines)
    })

    // XXX TODO: handle elements declarations.

    var elements = sections[SECTIONS.ELEMENT] || []
    elements.forEach(function(e, idx) {
      notImplemented()
    })

    // Fill the memory with data from the module.
    // XXX TODO: bounds checking etc

    var datas = sections[SECTIONS.DATA] || []
    datas.forEach(function(d, idx) {
      for (var i = 0; i < d.data.length; i++) {
        src.push("HI8[(" + d.offset.jsexpr + ") + " + i + "] = " + d.data.charCodeAt(i))
      }
    })

    // XXX TODO: run the `start` code if it exists.
    var start = sections[SECTIONS.START]
    if (start !== null) {
      src.push("F" + start + "()")
    }

    // Return the exports as an object.

    src.push("return {")
    var exports = sections[SECTIONS.EXPORT] || []
    exports.forEach(function(e, idx) {
      var ref = "trap()"
      switch (e.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          ref = "F" + e.index
          break
        case EXTERNAL_KINDS.GLOBAL:
          ref = "G" + e.index
          break
        case EXTERNAL_KINDS.MEMORY:
          ref = "M" + e.index
          break
        case EXTERNAL_KINDS.TABLE:
          ref = "T" + e.index
          break
      }
      src.push("  '" + e.field + "' :" + ref + (idx == exports.length - 1 ? "" : ","))
    })
    src.push("}")

    // That's it!  Compile it as a function and return it.
    var code = src.join("\n")
    //dump(code)
    //dump("---")
    return new Function("imports", "stdlib", code)
  }


  //
  // A "standard library" of utility functions for the copiled code.
  // Many of these are likely to be suboptimal, but it's a start.
  //

  var scratchBuf = new ArrayBuffer(8)
  var scratchBytes = new Uint8Array(scratchBuf)
  var scratchData = new DataView(scratchBuf)

  var stdlib = {}

  // Helpful constants.
  stdlib.INT32_MIN = 0x80000000|0
  stdlib.INT32_MAX = 0x7FFFFFFF|0

  // Misc structural functions.
  stdlib.trap = function() { throw new WebAssembly.RuntimeError() }

  // i32 operations that are not primitive operators
  stdlib.i32_mul = Math.imul
  stdlib.i32_clz = Math.clz32
  stdlib.i32_rotl = function(v, n) { return ((v << n) | (v >>> (32 - n)) )|0}
  stdlib.i32_rotr = function(v, n) { return ((v >>> n) | (v << (32 - n)) )|0}
  stdlib.i32_ctz = function(v) {
    v = v|0
    var count = 0
    var bit = 0x01
    while (bit && (v & bit) === 0) {
      count++
      bit = (bit << 1) & 0xFFFFFFFF
    }
    return count
  }
  stdlib.i32_popcnt = function(v) {
    v = v|0
    var count = 0
    var bit = 0x01
    while (bit) {
      if (v & bit) { count++ }
      bit = (bit << 1) & 0xFFFFFFFF
    }
    return count
  }

  // i64 operations
  stdlib.i64_add = function(lhs, rhs) { return lhs.add(rhs) }
  stdlib.i64_sub = function(lhs, rhs) { return lhs.sub(rhs) }
  stdlib.i64_mul = function(lhs, rhs) { return lhs.mul(rhs) }
  stdlib.i64_div_s = function(lhs, rhs) { return lhs.div(rhs) }
  stdlib.i64_div_u = function(lhs, rhs) { return lhs.toUnsigned().div(rhs.toUnsigned().toUnsigned()) }
  stdlib.i64_rem_s = function(lhs, rhs) { return lhs.mod(rhs) }
  stdlib.i64_rem_u = function(lhs, rhs) { return lhs.toUnsigned().mod(rhs.toUnsigned()).toUnsigned().toSigned() }
  stdlib.i64_and = function(lhs, rhs) { return lhs.and(rhs) }
  stdlib.i64_or = function(lhs, rhs) { return lhs.or(rhs) }
  stdlib.i64_xor = function(lhs, rhs) { return lhs.xor(rhs) }
  stdlib.i64_shl = function(lhs, rhs) { return lhs.shl(rhs) }
  stdlib.i64_shr_s = function(lhs, rhs) { return lhs.shr(rhs) }
  stdlib.i64_shr_u = function(lhs, rhs) { return lhs.shru(rhs) }
  stdlib.i64_eq = function(lhs, rhs) { return lhs.eq(rhs) }
  stdlib.i64_ne = function(lhs, rhs) { return lhs.neq(rhs) }
  stdlib.i64_lt_s = function(lhs, rhs) { return lhs.lt(rhs) }
  stdlib.i64_lt_u = function(lhs, rhs) { return lhs.toUnsigned().lt(rhs.toUnsigned()) }
  stdlib.i64_gt_s = function(lhs, rhs) { return lhs.gt(rhs) }
  stdlib.i64_gt_u = function(lhs, rhs) { return lhs.toUnsigned().gt(rhs.toUnsigned()) }
  stdlib.i64_le_s = function(lhs, rhs) { return lhs.lte(rhs) }
  stdlib.i64_le_u = function(lhs, rhs) { return lhs.toUnsigned().lte(rhs.toUnsigned()) }
  stdlib.i64_ge_s = function(lhs, rhs) { return lhs.gte(rhs) }
  stdlib.i64_ge_u = function(lhs, rhs) { return lhs.toUnsigned().gte(rhs.toUnsigned()) }
  stdlib.i64_rotl = function(v, n) { return v.shl(n).or(v.shru(Long.fromNumber(64).sub(n)))}
  stdlib.i64_rotr = function(v, n) { return v.shru(n).or(v.shl(Long.fromNumber(64).sub(n)))}
  stdlib.i64_clz = function(v) {
    var count = stdlib.i32_clz(v.getHighBits())
    if (count === 32) {
      count += stdlib.i32_clz(v.getLowBits())
    }
    return Long.fromNumber(count)
  }  
  stdlib.i64_ctz = function(v) {
    var count = stdlib.i32_ctz(v.getLowBits())
    if (count === 32) {
      count += stdlib.i32_ctz(v.getHighBits())
    }
    return Long.fromNumber(count)
  }
  stdlib.i64_popcnt = function(v) {
    return Long.fromNumber(stdlib.i32_popcnt(v.getHighBits()) + stdlib.i32_popcnt(v.getLowBits()))
  }
  stdlib.i64_reinterpret_f64 = function(v) {
    scratchData.setFloat64(0, v, true)
    var low = scratchData.getInt32(0, true)
    var high = scratchData.getInt32(4, true)
    return new Long(low, high)
  }

  // f32 operations
  stdlib.ToF32 = Math.fround
  stdlib.f32_min = Math.min
  stdlib.f32_max = Math.max
  stdlib.f32_sqrt = Math.sqrt
  stdlib.f32_floor = Math.floor
  stdlib.f32_ceil = Math.ceil
  stdlib.f32_trunc = Math.trunc
  stdlib.f32_nearest = function (v) {
    // ties to even...there must be a better way??
    if (Math.abs(v - Math.trunc(v)) === 0.5) { return 2 * Math.round(v / 2) }
    return Math.round(v)
  }
  stdlib.f32_abs = function (v) {
    if (isNaN(v)) {
      scratchData.setFloat32(0, v, true)
      scratchBytes[3] &= ~0x80
      return scratchData.getFloat32(0, true)
    }
    return Math.abs(v)
  }
  stdlib.f32_signof = function(v) {
    if (isNaN(v)) {
      scratchData.setFloat32(0, v, true)
      return (scratchBytes[3] & 0x80) ? -1 : 1
    }
    return (v > 0 || 1 / v > 0) ? 1 : -1
  }
  stdlib.f32_copysign = function (x, y) {
    if (isNaN(x)) {
      scratchData.setFloat32(0, x, true)
      if (stdlib.f32_signof(y) === -1) {
        scratchBytes[3] |= 0x80
      } else {
        scratchBytes[3] &= ~0x80
      }
      return scratchData.getFloat32(0, true)
    }
    return stdlib.f32_signof(y) * Math.abs(x)
  }

  // f64 operations
  stdlib.f64_min = Math.min
  stdlib.f64_max = Math.max
  stdlib.f64_sqrt = Math.sqrt
  stdlib.f64_floor = Math.floor
  stdlib.f64_ceil = Math.ceil
  stdlib.f64_trunc = Math.trunc
  stdlib.f64_nearest = stdlib.f32_nearest
  stdlib.f64_abs = function (v) {
    if (isNaN(v)) {
      scratchData.setFloat64(0, v, true)
      scratchBytes[7] &= ~0x80
      return scratchData.getFloat64(0, true)
    }
    return Math.abs(v)
  }
  stdlib.f64_neg = function (v) {
    if (isNaN(v)) {
      scratchData.setFloat64(0, v, true)
      if (scratchBytes[7] & 0x80) {
        scratchBytes[7] &= ~0x80
      } else {
        scratchBytes[7] |= 0x80
      }
      return scratchData.getFloat64(0, true)
    }
    return -v
  }
  stdlib.f64_signof = function(v) {
    if (isNaN(v)) {
      scratchData.setFloat64(0, v, true)
      return (scratchBytes[7] & 0x80) ? -1 : 1
    }
    return (v > 0 || 1 / v > 0) ? 1 : -1
  }
  stdlib.f64_copysign = function (x, y) {
    if (isNaN(x)) {
      scratchData.setFloat64(0, x, true)
      if (stdlib.f64_signof(y) === -1) {
        scratchBytes[7] |= 0x80
      } else {
        scratchBytes[7] &= ~0x80
      }
      return scratchData.getFloat64(0, true)
    }
    return stdlib.f32_signof(y) * Math.abs(x)
  }

  //
  // Various misc helper functions.
  //

  function trap() {
    throw new RuntimeError()
  }

  function assertIsDefined(obj) {
    if (typeof obj === "undefined") {
      throw new TypeError()
    }
  }

  function assertIsInstance(obj, Cls) {
    if (!obj instanceof Cls) {
      throw new TypeError()
    }
  }

  function assertIsType(obj, typstr) {
    if (typeof obj !== typstr) {
      throw new TypeError()
    }
  }

  function assertIsCallable(obj) {
    // XXX TODO: more complicated cases
    if (typeof obj !== "function" ) {
      throw new TypeError()
    }
  }

  function ToWebAssemblyValue(jsValue, kind) {
    switch (kind) {
      case "i32":
        return jsValue|0
      case "i64":
        throw new TypeError()
      case "f32":
        return +jsValue
      case "f64":
        return +jsValue
      default:
        throw new TypeError()
    }
  }

  function ToNonWrappingUint32(v) {
    // XXX TODO: throw RangeError if > UINT32_MAX
    return v >>> 0
  }

  function arrayBufferFromBufferSource(source) {
    if (source instanceof ArrayBuffer) {
      return source
    }
    const viewClasses = [
      Int8Array,
      Int16Array,
      Int32Array,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Uint8ClampedArray,
      Float32Array,
      Float64Array,
      DataView
    ]
    for (var i = 0; i < viewClasses.length; i++) {
      if (source instanceof viewClasses[i]) {
        return source.buffer
      }
    }
    return null
  }

  function renderJSValue(v) {
    // We need to preserve two things that don't round-trip through v.toString():
    //  * the distinction between -0 and 0
    //  * the precise bit-pattern of an NaN
    if (typeof v === "number") {
      if (isNaN(v)) {
        scratchData.setFloat64(0, v, true)
        return "WebAssembly._fromNaNBytes([" + scratchBytes.join(",") + "])"
      }
      return ((v < 0 || 1 / v < 0) ? "-" : "") + Math.abs(v)
    }
    return "" + v
  }

  function _fromNaNBytes(bytes) {
    for (var i = 0; i < 8; i++) {
      scratchBytes[i] = bytes[i]
    }
    return scratchData.getFloat64(0, true)
  }

  return WebAssembly

})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this);
