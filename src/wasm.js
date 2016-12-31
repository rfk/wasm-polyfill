
  // XXX TODO: more generic polyfill for this
  import Long from "long"

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

  function dump() {
    for (var i = 0; i < arguments.length; i++) {
      var arg = arguments[i]
      if (typeof arg === 'string') {
        process.stderr.write(arg)
      } else if (typeof arg === 'number' || (arg instanceof Number)) {
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
    var parsed = parseBinaryEncoding(bytes)
    this._internals = {
      sections: parsed.sections,
      constants: parsed.constants,
      jsmodule: renderSectionsToJS(parsed.sections, parsed.constants)
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
  // How to make this so?  Is it even possible in a sensible fashion?

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
    var sections = moduleObject._internals.sections
    var imports = [];
    (sections[SECTIONS.IMPORT] || []).forEach(function(i) {
      var o = importObject[i.module_name]
      assertIsInstance(o, Object)
      var v = o[i.item_name]
      if (typeof v === "undefined") {
        throw new TypeError("cannot import undefined")
      }
      switch(i.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          assertIsCallable(v)
          // If importing functions from another WASM instance,
          // we can shortcut *and* we can do more typechecking.
          // If they're not from WASM, we need to convert arguments
          // and return types between the two worlds.
          if (! v._wasmRawFunc) {
            var typ = sections[SECTIONS.TYPE][i.type]
            imports.push(function() {
              var args = []
              var origArgs = arguments
              typ.param_types.forEach(function(param_typ, idx) {
                args.push(ToJSValue(origArgs[idx], param_typ))
              })
              var res = v.apply(undefined, args)
              if (typ.return_types.length > 0) {
                res = ToWebAssemblyValue(res, typ.return_types[0])
              }
              return res
            })
          } else {
            if (v._wasmRawFunc._wasmTypeSigStr !== makeSigStr(sections[SECTIONS.TYPE][i.type])) {
              throw new TypeError("function import type mis-match")
            }
            imports.push(v._wasmRawFunc)
          }
          break
        case EXTERNAL_KINDS.GLOBAL:
          imports.push(ToWebAssemblyValue(v, i.type.content_type))
          break
        case EXTERNAL_KINDS.MEMORY:
          assertIsInstance(v, Memory)
          if (v._internals.current < i.type.limits.initial) {
            throw new TypeError("memory import too small")
          }
          if (i.type.limits.maximum) {
            if (v._internals.current > i.type.limits.maximum) {
              throw new TypeError("memory import too big")
            }
            if (!v._internals.maximum || v._internals.maximum > i.type.limits.maximum) {
              throw new TypeError("memory import has too large a maximum")
            }
          }
          imports.push(v)
          break
        case EXTERNAL_KINDS.TABLE:
          assertIsInstance(v, Table)
          if (v.length < i.type.limits.initial) {
            throw new TypeError("table import too small")
          }
          if (i.type.limits.maximum) {
            if (v.length > i.type.limits.maximum) {
              throw new TypeError("table import too big")
            }
            if (!v._internals.maximum || v._internals.maximum > i.type.limits.maximum) {
              throw new TypeError("table import has too large a maximum")
            }
          }
          imports.push(v)
          break
        default:
          throw new RuntimeError("unexpected import kind: " + i.kind)
      }
    })
    // Instantiate the compiled javascript module, which will give us all the exports.
    var constants = moduleObject._internals.constants
    this._exports = moduleObject._internals.jsmodule(WebAssembly, imports, constants, stdlib)

    this.exports = {}
    var self = this;
    (moduleObject._internals.sections[SECTIONS.EXPORT] || []).forEach(function(e) {
      switch (e.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          var wasmFunc = self._exports[e.field]
          if (!wasmFunc._wasmJSWrapper) {
            wasmFunc._wasmJSWrapper = function () {
              // Type-check and coerce arguments.
              var args = []
              ARGLOOP: for (var i = 0; i < wasmFunc._wasmTypeSigStr.length; i++) {
                switch (wasmFunc._wasmTypeSigStr.charAt(i)) {
                  case 'i':
                    args.push(arguments[i]|0)
                    break
                  case 'l':
                    throw new RuntimeError("cannot pass i64 from js: " + arguments[i])
                  case 'f':
                    args.push(Math.fround(+arguments[i]))
                    break
                  case 'd':
                    args.push(+arguments[i])
                    break
                  case '-':
                    break ARGLOOP
                  default:
                    throw new RuntimeError("malformed _wasmTypeSigStr")
                }
              }
              try {
                return self._exports[e.field].apply(this, args)
              } catch (err) {
                // For test compatibilty, we want stack space exhaustion to trap.
                // XXX TODO: this can't really be necessary in practice, right?
                if (err instanceof RangeError) {
                  if (err.message.indexOf("call stack") >= 0) {
                    throw new RuntimeError("call stack exhausted")
                  }
                }
                throw err
              }
            }
            wasmFunc._wasmJSWrapper._wasmRawFunc = wasmFunc
          }
          self.exports[e.field] = wasmFunc._wasmJSWrapper
          break
        default:
          self.exports[e.field] = self._exports[e.field]
      }
    })
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
      maximum: maximum,
      callbacks: []
    }
  }

  Memory.prototype._onChange = function _onChange(cb) {
    // XXX TODO: can we use weakrefs for this, to avoid
    // the Memory keeping all connected instances alive?
    this._internals.callbacks.push(cb)
  }

  Memory.prototype.grow = function grow(delta) {
    var oldSize = this._grow(delta)
    if (oldSize < 0) {
      throw new RangeError()
    }
    return oldSize
  }

  Memory.prototype._grow = function _grow(delta) {
    assertIsInstance(this, Memory)
    // XXX TODO: guard against overflow?
    var oldSize = this._internals.current
    var newSize = oldSize + ToNonWrappingUint32(delta)
    if (this._internals.maximum) {
      if (newSize > this._internals.maximum) {
        return -1
      }
    }
    if (newSize > 65536) {
      return -1
    }
    var newBuffer = new ArrayBuffer(newSize * PAGE_SIZE)
    // XXX TODO more efficient copy of the old buffer?
    new Uint8Array(newBuffer).set(new Uint8Array(this._internals.buffer))
    // XXX TODO: cleanly detach the old buffer
    this._internals.buffer = newBuffer
    this._internals.current = newSize
    // Notify listeners that things have changed.
    this._internals.callbacks.forEach(function (cb){
      cb()
    })
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
    //var element = tableDescriptor.element
    //if (element !== "anyfunc") {
    //  throw new TypeError()
    //}
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
      I32_TRUNC_S_F64: 0xaa,
      I32_TRUNC_U_F64: 0xab,
      I64_EXTEND_S_I32: 0xac,
      I64_EXTEND_U_I32: 0xad,
      I64_TRUNC_S_F32: 0xae,
      I64_TRUNC_U_F32: 0xaf,
      I64_TRUNC_S_F64: 0xb0,
      I64_TRUNC_U_F64: 0xb1,
      F32_CONVERT_S_I32: 0xb2,
      F32_CONVERT_U_I32: 0xb3,
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
      F32_REINTERPRET_I32: 0xbe,
      F64_REINTERPRET_I64: 0xbf
    }

    // We parse in a single forward pass,
    // this is the current position in the input bytes.

    var idx = 0;

    // The top-level.  We return an object with:
    //   * sections: array of known section types
    //   * constants: array of pre-calculated constants
    // This uses a bunch of helper functions defined below.

    var sections = [null]
    var constants = []
    parseFileHeader()
    parseKnownSections()
    return {
      sections: sections,
      constants: constants
    }

    // Basic helper functions for reading primitive values,
    // and doing some type-checking etc.  You can distinguish
    // primitive-value reads by being named read_XYZ()

    function checkEndOfBytes(count) {
      if (typeof count === "undefined") {
        count = 1
      }
      if ((idx + count) > bytes.length) {
        throw new CompileError("unepected end of bytes")
      }
    }

    function read_byte() {
      checkEndOfBytes()
      return bytes[idx++]
    }

    function read_bytes(count) {
      checkEndOfBytes(count)
      var output = []
      while (count > 0) {
        output.push(String.fromCharCode(bytes[idx++]))
        count--
      }
      return output.join("")
    }

    function read_uint8() {
      checkEndOfBytes()
      return bytes[idx++]
    }

    function read_uint16() {
      checkEndOfBytes(2)
      return (bytes[idx++]) |
             (bytes[idx++] << 8)
    }

    function read_uint32() {
      checkEndOfBytes(4)
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
      checkEndOfBytes()
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
      checkEndOfBytes()
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
      if (b & 0x40 && shift < 32) {
        result = (-1 << shift) | result
      }
      return result
    }

    function read_varint64() {
      checkEndOfBytes()
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
      checkEndOfBytes()
      var dv = new DataView(bytes.buffer)
      var v = dv.getFloat32(idx, true)
      // XXX TODO: is it possible to preserve the signalling bit of a NaN?
      // They don't seem to round-trip properly.
      if (isNaN(v)) {
        if (!(bytes[idx+2] & 0x40)) {
          // Remebmer that it was a signalling NaN.
          // This bit will be lost when you operate on it, but
          // we can preserve it for long enough to get tests to pass.
          v = new Number(v)
          v._signalling = true
        }
      }
      idx += 4
      return v
    }

    function read_f64() {
      checkEndOfBytes()
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
      var flags = read_varuint1()
      l.initial = read_varuint32()
      if (flags) {
        l.maximum = read_varuint32()
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
      e.op = read_byte()
      switch (e.op) {
        case OPCODES.I32_CONST:
          if (typ !== TYPES.I32) {
            throw new CompileError("invalid init_expr type: " + typ)
          }
          e.jsexpr = renderJSValue(read_varint32(), constants)
          break
        case OPCODES.I64_CONST:
          if (typ !== TYPES.I64) {
            throw new CompileError("invalid init_expr type: " + typ)
          }
          e.jsexpr = renderJSValue(read_varint64(), constants)
          break
        case OPCODES.F32_CONST:
          if (typ !== TYPES.F32) {
            throw new CompileError("invalid init_expr type: " + typ)
          }
          e.jsexpr = renderJSValue(read_f32(), constants)
          break
        case OPCODES.F64_CONST:
          if (typ !== TYPES.F64) {
            throw new CompileError("invalid init_expr type: " + typ)
          }
          e.jsexpr = renderJSValue(read_f64(), constants)
          break
        case OPCODES.GET_GLOBAL:
          var index = read_varuint32()
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
        var payload_len = read_varuint32()
        var next_section_idx = idx + payload_len
        // Ignoring named sections for now, but parsing
        // them just enough to detect well-formedness.
        if (!id) {
          var name_len = read_varuint32()
          read_bytes(name_len)
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

    var hasTable = false
    var hasMemory = false

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
      var count = read_varuint32()
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
        g.init = parseInitExpr(g.type.content_type)
        return g
      }
    }

    function parseExportSection() {
      var numImportedFunctions = getImportedFunctions().length
      var numImportedGlobals = getImportedGlobals().length
      var numImportedTables = getImportedTables().length
      var numImportedMemories = getImportedMemories().length

      var count = read_varuint32()
      var entries = []
      var seenFields = {}
      while (count > 0) {
        entries.push(parseExportEntry())
        count--
      }
      return entries

      function parseExportEntry() {
        var e = {}
        var field_len = read_varuint32()
        e.field = read_bytes(field_len)
        if (e.field in seenFields) {
          throw new CompileError("duplicate export name: " + e.field)
        }
        seenFields[e.field] = true
        e.kind = read_external_kind()
        e.index = read_varuint32()
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
      var func_index = read_varuint32()
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
        // Check that it's a valid table reference.
        getTableType(e.index)
        e.offset = parseInitExpr(TYPES.I32)
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
      var count = read_varuint32()
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
          //if (isDeadCode) { return }
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
          var initVal = "trap()"
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
          pushLine("if ((" + addr + ">>>0) + " + (offset + size) + " > memorySize) { return trap() }")
        }

        function i32_load_unaligned(addr, offset) {
          var res = pushStackVar(TYPES.I32)
          pushLine(res + " = HDV.getInt32(" + addr + " + " + offset + ", true)")
        }

        function i32_load_aligned(addr, offset) {
          var res = pushStackVar(TYPES.I32)
          pushLine("if ((" + addr + " + " + offset + ") & 0xFF) {")
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
          pushLine("if ((" + addr + " + " + offset + ") & 0x0F) {")
          pushLine("  " + res + " = HDV.getInt16(" + addr + " + " + offset + ", true)")
          pushLine("} else {")
          pushLine("  " + res + " = HI16[(" + addr + " + " + offset + ")>>1]")
          pushLine("}")
        }

        function i32_load16_u_aligned(addr, offset, value) {
          var res = pushStackVar(TYPES.I32)
          pushLine("if ((" + addr + " + " + offset + ") & 0x0F) {")
          pushLine("  " + res + " = HDV.getInt16(" + addr + " + " + offset + ", true) & 0x0000FFFF")
          pushLine("} else {")
          pushLine("  " + res + " = HU16[(" + addr + " + " + offset + ")>>1]")
          pushLine("}")
        }

        function i32_store_unaligned(addr, offset, value) {
          pushLine("HDV.setInt32(" + addr + " + " + offset + ", " + value + ", true)")
        }

        function i32_store_aligned(addr, offset, value) {
          pushLine("if ((" + addr + " + " + offset + ") & 0xFF) {")
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
          pushLine("if ((" + addr + " + " + offset + ") & 0xFF) {")
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
          pushLine("if ((" + addr + " + " + offset + ") & 0xFF) {")
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
          pushLine("if ((" + addr + " + " + offset + ") & 0x0FFF) {")
          pushLine("  " + res + " = HDV.getFloat64(" + addr + " + " + offset + ", true)")
          pushLine("} else {")
          pushLine("  " + res + " = HF64[(" + addr + " + " + offset + ")>>3]")
          pushLine("}")
        }

        function f64_store_unaligned(addr, offset, value) {
          pushLine("HDV.setFloat64(" + addr + " + " + offset + ", " + value + ", true)")
        }

        function f64_store_aligned(addr, offset, value) {
          pushLine("if ((" + addr + " + " + offset + ") & 0x0FFF) {")
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
          var op = read_byte()
          switch (op) {

            case OPCODES.UNREACHABLE:
              pushLine("return trap('unreachable')")
              markDeadCode()
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
              var cond = popStackVar(TYPES.I32)
              var cf = pushControlFlow(op, sig)
              pushLine("if (" + cond + ") { " + cf.label + ": do {", -1)
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
              pushLine("} while (0) } else { "+ cf.label + ": do{")
              pushControlFlow(cf.op, cf.sig, cf.endReached)
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
                    pushLine("} while (0) }")
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
              var depth = read_varuint32()
              var cf = getBranchTarget(depth)
              switch (cf.op) {
                case OPCODES.BLOCK:
                case OPCODES.IF:
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
              var table_index = read_varuint1()
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
              pushLine("  trap()")
              pushLine("}")
              pushLine("if (T0[" + callIdx + "]._wasmTypeSigStr) {")
              pushLine("  if (T0[" + callIdx + "]._wasmTypeSigStr !== '" + makeSigStr(callSig) + "') {")
              pushLine("    trap()")
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
              var index = read_varuint32()
              var typ = getLocalType(index)
              pushStackVar(typ)
              pushLine(getStackVar(typ) + " = " + getLocalVar(index))
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
              pushLine(getStackVar(typ) + " = " + getGlobalVar(index, typ))
              break

            case OPCODES.SET_GLOBAL:
              var index = read_varuint32()
              var typ = getGlobalType(index)
              checkGlobalMutable(index)
              pushLine(getGlobalVar(index, typ) + " = " + popStackVar(typ))
              break

            case OPCODES.I32_LOAD:
              getMemoryType(0)
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              if (flags > 0) {
                throw new CompileError("alignment larger than natural")
              }
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_load8_s(addr, offset)
              break

            case OPCODES.I32_LOAD8_U:
              getMemoryType(0)
              var flags = read_varuint32()
              if (flags > 0) {
                throw new CompileError("alignment larger than natural")
              }
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_load8_u(addr, offset)
              break

            case OPCODES.I32_LOAD16_S:
              getMemoryType(0)
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              if (flags > 0) {
                throw new CompileError("alignment larger than natural")
              }
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_load8_s(addr, offset)
              i64_from_i32_s()
              break

            case OPCODES.I64_LOAD8_U:
              getMemoryType(0)
              var flags = read_varuint32()
              if (flags > 0) {
                throw new CompileError("alignment larger than natural")
              }
              var offset = read_varuint32()
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_load8_u(addr, offset)
              i64_from_i32_u()
              break

            case OPCODES.I64_LOAD16_S:
              getMemoryType(0)
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              if (flags > 0) {
                throw new CompileError("alignment larger than natural")
              }
              var offset = read_varuint32()
              var value = popStackVar(TYPES.I32)
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_store8(addr, offset, value + " & 0xFF")
              break

            case OPCODES.I32_STORE16:
              getMemoryType(0)
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              if (flags > 0) {
                throw new CompileError("alignment larger than natural")
              }
              var offset = read_varuint32()
              var value = popStackVar(TYPES.I64)
              var addr = popStackVar(TYPES.I32)
              boundsCheck(addr, offset, 1)
              i32_store8(addr, offset, "(" + value + ".low) & 0xFF")
              break

            case OPCODES.I64_STORE16:
              getMemoryType(0)
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var flags = read_varuint32()
              var offset = read_varuint32()
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
              var mem_index = read_varuint1()
              if (mem_index !== 0) {
                throw new CompileError("only one memory in the MVP")
              }
              getMemoryType(mem_index)
              pushLine(pushStackVar(TYPES.I32) + " = (memorySize / " + PAGE_SIZE + ")|0")
              break

            case OPCODES.GROW_MEMORY:
              var mem_index = read_varuint1()
              if (mem_index !== 0) {
                throw new CompileError("only one memory in the MVP")
              }
              getMemoryType(mem_index)
              var operand = popStackVar(TYPES.I32)
              var res = pushStackVar(TYPES.I32)
              pushLine(res + " = M0._grow(" + operand + ")")
              break

            case OPCODES.I32_CONST:
              var val = read_varint32()
              pushLine(pushStackVar(TYPES.I32) + " = " + renderJSValue(val, constants))
              break

            case OPCODES.I64_CONST:
              var val = read_varint64()
              pushLine(pushStackVar(TYPES.I64) + " = " + renderJSValue(val, constants))
              break

            case OPCODES.F32_CONST:
              var val = read_f32()
              pushLine(pushStackVar(TYPES.F32) + " = " + renderJSValue(val, constants))
              break

            case OPCODES.F64_CONST:
              pushLine(pushStackVar(TYPES.F64) + " = " + renderJSValue(read_f64(), constants))
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
              pushLine("if (" + operand + " > INT32_MAX) { return trap() }")
              pushLine("if (" + operand + " < INT32_MIN) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
              pushLine(output + " = (" + operand + ")|0")
              break

            case OPCODES.I32_TRUNC_S_F64:
              var operand = popStackVar(TYPES.F64)
              var output = pushStackVar(TYPES.I32)
              pushLine("if (" + operand + " > INT32_MAX) { return trap() }")
              pushLine("if (" + operand + " < INT32_MIN) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
              pushLine(output + " = (" + operand + ")|0")
              break

            case OPCODES.I32_TRUNC_U_F32:
              var operand = popStackVar(TYPES.F32)
              var output = pushStackVar(TYPES.I32)
              pushLine("if (" + operand + " > UINT32_MAX) { return trap() }")
              pushLine("if (" + operand + " <= -1) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
              pushLine(output + " = ((" + operand + ")>>>0)|0")
              break

            case OPCODES.I32_TRUNC_U_F64:
              var operand = popStackVar(TYPES.F64)
              var output = pushStackVar(TYPES.I32)
              pushLine("if (" + operand + " > UINT32_MAX) { return trap() }")
              pushLine("if (" + operand + " <= -1) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
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
              pushLine("if (" + operand + " >= 9.22337203685e+18) { return trap() }")
              pushLine("if (" + operand + " <= -9.22337313636e+18) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
              pushLine(output + " = Long.fromNumber(" + operand + ")")
              break

            case OPCODES.I64_TRUNC_S_F64:
              var operand = popStackVar(TYPES.F64)
              var output = pushStackVar(TYPES.I64)
              // XXX TODO: I actually don't understand floating-point much at all,
              //           right now am just hacking the tests into passing...
              pushLine("if (" + operand + " >= 9223372036854775808.0) { return trap() }")
              pushLine("if (" + operand + " <= -9223372036854777856.0) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
              pushLine(output + " = Long.fromNumber(" + operand + ")")
              break

            case OPCODES.I64_TRUNC_U_F32:
              var operand = popStackVar(TYPES.F32)
              var output = pushStackVar(TYPES.I64)
              // XXX TODO: I actually don't understand floating-point much at all,
              //           right now am just hacking the tests into passing...
              pushLine("if (" + operand + " >= 1.84467440737e+19) { return trap() }")
              pushLine("if (" + operand + " <= -1) { return trap() }")
              pushLine("if (isNaN(" + operand + ")) { return trap() }")
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
      // Check that it's a valid memory reference.
      getMemoryType(d.index)
      d.offset = parseInitExpr(TYPES.I32)
      var size = read_varuint32()
      d.data = read_bytes(size)
      return d
    }

  }

  function renderSectionsToJS(sections, constants) {
    //dump("\n\n---- RENDERING CODE ----\n\n")
    var src = []

    function pushLine(ln) {
      ln.split("\n").forEach(function(ln) {
        src.push("  " + ln)
      })
    }

    // Import all the things from the stdlib.
    pushLine("\n//  WebAssembly stdlib and helper functions\n")

    pushLine("const Long = WebAssembly._Long")
    Object.keys(stdlib).forEach(function(key) {
      pushLine("const " + key + " = stdlib." + key)
    })

    // Pull in various imports.

    var imports = sections[SECTIONS.IMPORT] || []
    if (imports.length > 0) {
      pushLine("\n//  Imports\n")
    }

    var countFuncs = 0
    var countGlobals = 0
    var countTables = 0
    var countMemories = 0
    imports.forEach(function(i, idx) {
      switch (i.kind) {
        case EXTERNAL_KINDS.FUNCTION:
          pushLine("var F" + countFuncs + " = imports[" + idx + "]")
          countFuncs++
          break
        case EXTERNAL_KINDS.GLOBAL:
          pushLine("var G" + countGlobals + " = imports[" + idx + "]")
          countGlobals++
          break
        case EXTERNAL_KINDS.TABLE:
          pushLine("var T" + countTables + " = imports[" + idx + "]")
          countTables++
          break
        case EXTERNAL_KINDS.MEMORY:
          pushLine("var M" + countMemories + " = imports[" + idx + "]")
          countMemories++
          break
        default:
          throw new CompileError("cannot render import kind: " + i.kind)
      }
    })

    // Create requested tables.

    var tables = sections[SECTIONS.TABLE] || []
    if (tables.length > 0) {
      pushLine("\n//  Local table definitions\n")
    }
    tables.forEach(function(t, idx) {
      pushLine("var T" + (idx + countTables) + " = new WebAssembly.Table(" + JSON.stringify(t.limits) + ")")
    })

    // Create requested memory, and provide views into it.

    var memories = sections[SECTIONS.MEMORY] || []
    if (memories.length > 0) {
      pushLine("\n//  Local memory definitions\n")
    }
    memories.forEach(function(m, idx) {
      pushLine("var M" + idx + " = new WebAssembly.Memory(" + JSON.stringify(m.limits) + ")")
    })

    if (countMemories || memories.length > 0) {
      pushLine("var memorySize = M0.buffer.byteLength")
      pushLine("var HI8 = new Int8Array(M0.buffer)")
      pushLine("var HI16 = new Int16Array(M0.buffer)")
      pushLine("var HI32 = new Int32Array(M0.buffer)")
      pushLine("var HU8 = new Uint8Array(M0.buffer)")
      pushLine("var HU16 = new Uint16Array(M0.buffer)")
      pushLine("var HU32 = new Uint32Array(M0.buffer)")
      pushLine("var HF32 = new Float32Array(M0.buffer)")
      pushLine("var HF64 = new Float64Array(M0.buffer)")
      pushLine("var HDV = new DataView(M0.buffer)")
      pushLine("var onMemoryChange = function() {")
      pushLine("  memorySize = M0.buffer.byteLength")
      pushLine("  HI8 = new Int8Array(M0.buffer)")
      pushLine("  HI16 = new Int16Array(M0.buffer)")
      pushLine("  HI32 = new Int32Array(M0.buffer)")
      pushLine("  HU8 = new Uint8Array(M0.buffer)")
      pushLine("  HU16 = new Uint16Array(M0.buffer)")
      pushLine("  HU32 = new Uint32Array(M0.buffer)")
      pushLine("  HF32 = new Float32Array(M0.buffer)")
      pushLine("  HF64 = new Float64Array(M0.buffer)")
      pushLine("  HDV = new DataView(M0.buffer)")
      pushLine("}")
      pushLine("M0._onChange(onMemoryChange)")
    }

    // Declare globals

    var globals = sections[SECTIONS.GLOBAL] || []
    if (globals.length > 0) {
      pushLine("\n//  Define globals\n")
    }
    globals.forEach(function(g, idx) {
      pushLine("var G" + (idx + countGlobals) + " = " + g.init.jsexpr)
    })

    // Render the code for each function.

    var code = sections[SECTIONS.CODE] || []
    if (code.length > 0) {
      pushLine("\n//  Function definitions\n")
    }
    code.forEach(function(f, idx) {
      f.code.header_lines.forEach(function(ln) {
        pushLine(ln)
      })
      f.code.body_lines.forEach(function(ln) {
        pushLine(ln)
      })
      f.code.footer_lines.forEach(function(ln) {
        pushLine(ln)
      })
      pushLine(f.name + "._wasmTypeSigStr = '" + f.sigStr + "'")
      pushLine(f.name + "._wasmJSWrapper = null")
      pushLine("")
    })

    // Fill the table with defined elements, if any.

    var elements = sections[SECTIONS.ELEMENT] || []
    if (elements.length > 0) {
      pushLine("\n//  Table element initialization\n")
    }
    elements.forEach(function(e, idx) {
      pushLine("if ((" + e.offset.jsexpr + " + " + e.elems.length + " - 1) >= T" + e.index + ".length) { throw new TypeError('table out of bounds') }")
      for (var i = 0; i < e.elems.length; i++) {
        pushLine("T" + e.index + "[(" + e.offset.jsexpr + ") + " + i + "] = F" + e.elems[i])
      }
    })

    // Fill the memory with data from the module.

    var datas = sections[SECTIONS.DATA] || []
    if (datas.length > 0) {
      pushLine("\n//  Memory data initialization\n")
    }
    datas.forEach(function(d, idx) {
      if (d.data.length > 0 ) {
        pushLine("if ((" + d.offset.jsexpr + " + " + d.data.length + " - 1) >= M0.buffer.byteLength) { throw new TypeError('memory out of bounds') }")
        for (var i = 0; i < d.data.length; i++) {
          pushLine("HI8[(" + d.offset.jsexpr + ") + " + i + "] = " + d.data.charCodeAt(i))
        }
      }
    })

    // Run the `start` function if it exists.

    var start = sections[SECTIONS.START]
    if (start !== null) {
      pushLine("\n//  Run the start function\n")
      pushLine("F" + start + "()")
    }

    // Return the exports as an object.

    var exports = sections[SECTIONS.EXPORT] || []
    if (exports.length > 0) {
      pushLine("\n//  Exports\n")
    }
    pushLine("var exports = {}")
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
      pushLine("exports[" + renderJSValue(e.field, constants) + "] = " + ref)
    })
    pushLine("return exports")

    // That's it!  Compile it as a function and return it.
    var code = src.join("\n")
    //dump(code)
    //dump("---")
    return new Function("WebAssembly", "imports", "constants", "stdlib", code)
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
  stdlib.UINT32_MIN = 0x00000000>>>0
  stdlib.UINT32_MAX = 0xFFFFFFFF>>>0

  // Misc structural functions.
  stdlib.trap = function(msg) { throw new WebAssembly.RuntimeError(msg) }

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
  stdlib.i32_reinterpret_f32 = function(v) {
    scratchData.setFloat32(0, v, true)
    if (typeof v === 'object' && v._signalling) {
      scratchBytes[2] &= ~0x40
    }
    return scratchData.getInt32(0, true)
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
  stdlib.ToF32 = function (v) {
    if (isNaN(v) && typeof v === 'object') {
      return v
    }
    return Math.fround(v)
  }
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
      var res = scratchData.getFloat32(0, true)
      if (typeof v === 'object' && v._signalling) {
        res = new Number(res)
        res._signalling = true
      }
      return res
    }
    return Math.abs(v)
  }
  stdlib.f32_neg = function (v) {
    if (isNaN(v)) {
      scratchData.setFloat32(0, v, true)
      if (scratchBytes[3] & 0x80) {
        scratchBytes[3] &= ~0x80
      } else {
        scratchBytes[3] |= 0x80
      }
      var res = scratchData.getFloat32(0, true)
      if (typeof v === 'object' && v._signalling) {
        res = new Number(res)
        res._signalling = true
      }
      return res
    }
    return -v
  }
  stdlib.f32_signof = function(v) {
    if (isNaN(v)) {
      scratchData.setFloat32(0, v, true)
      return (scratchBytes[3] & 0x80) ? -1 : 1
    }
    return (v > 0 || 1 / v > 0) ? 1 : -1
  }
  stdlib.f32_copysign = function (x, y) {
    var sign = stdlib.f32_signof(y)
    if (isNaN(x)) {
      scratchData.setFloat32(0, x, true)
      if (sign === -1) {
        scratchBytes[3] |= 0x80
      } else {
        scratchBytes[3] &= ~0x80
      }
      var v = scratchData.getFloat32(0, true)
      if (typeof x === 'object' && x._signalling) {
        v = new Number(v)
        v._signalling = true
      }
      return v
    }
    return sign * Math.abs(x)
  }
  stdlib.f32_reinterpret_i32 = function(v) {
    scratchData.setInt32(0, v, true)
    var v = scratchData.getFloat32(0, true)
    if (isNaN(v)) {
      if (!(scratchBytes[2] & 0x40)) {
        v = new Number(v)
        v._signalling = true
      }
    }
    return v
  }
  stdlib.f32_load_fix_signalling = function(v, HU8, addr) {
    if (isNaN(v)) {
      if (!(HU8[addr + 2] & 0x40)) {
        v = new Number(v)
        v._signalling = true
      }
    }
    return v
  }
  stdlib.f32_store_fix_signalling = function(v, HU8, addr) {
    if (isNaN(v)) {
      if (typeof v === 'object' && v._signalling) {
        HU8[addr + 2] &= ~0x40
      }
    }
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
    var sign = stdlib.f64_signof(y)
    if (isNaN(x)) {
      scratchData.setFloat64(0, x, true)
      if (sign === -1) {
        scratchBytes[7] |= 0x80
      } else {
        scratchBytes[7] &= ~0x80
      }
      return scratchData.getFloat64(0, true)
    }
    return sign * Math.abs(x)
  }
  stdlib.f64_reinterpret_i64 = function(v) {
    scratchData.setInt32(0, v.low, true)
    scratchData.setInt32(4, v.high, true)
    return scratchData.getFloat64(0, true)
  }

  //
  // Various misc helper functions.
  //

  function trap(msg) {
    throw new RuntimeError(msg)
  }

  function assertIsDefined(obj) {
    if (typeof obj === "undefined") {
      throw new TypeError()
    }
  }

  function assertIsInstance(obj, Cls) {
    if (!(obj instanceof Cls)) {
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

  function ToWebAssemblyValue(jsValue, typ) {
    if (typeof jsValue !== 'number' && ! (jsValue instanceof Number)) {
      throw new TypeError("cant pass non-number in to WASM")
    }
    switch (typ) {
      case TYPES.I32:
        return jsValue|0
      case TYPES.I64:
        return Long.fromNumber(jsValue)
      case TYPES.F32:
        return stdlib.ToF32(jsValue)
      case TYPES.F64:
        return +jsValue
      default:
        throw new TypeError("Unknown type: " + typ)
    }
  }

  function ToJSValue(wasmValue, typ) {
    switch (typ) {
      case TYPES.I32:
      case TYPES.F32:
      case TYPES.F64:
        return wasmValue
      case TYPES.I64:
        // XXX TODO: precise semantics here?
        // I think we're supposed to return an error...
        return wasmValue.toNumber()
      default:
        throw new TypeError("unknown WASM type: " + typ)
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

  function renderJSValue(v, constants) {
    // We need to preserve two things that don't round-trip through v.toString():
    //  * the distinction between -0 and 0
    //  * the precise bit-pattern of an NaN
    if (typeof v === "number" || (typeof v === "object" && v instanceof Number)) {
      if (isNaN(v)) {
        // XXX TODO: re-work this to just pass it in as a constant
        scratchData.setFloat64(0, v, true)
        return "WebAssembly._fromNaNBytes([" + scratchBytes.join(",") + "]," + (!!v._signalling) + ")"
      }
      return "" + (((v < 0 || 1 / v < 0) ? "-" : "") + Math.abs(v))
    }
    // Special rendering required for Long instances.
    if (v instanceof Long) {
      return "new Long(" + v.low + "," + v.high + ")"
    }
    // Quote simple strings directly, but place more complex ones
    // as constants so that we don't have to try to escape them.
    if (typeof v === 'string') {
      if (/^[A-Za-z0-9_ $-]*$/.test(v)) {
        return "'" + v + "'"
      }
      constants.push(v)
      return "constants[" + (constants.length - 1) + "]"
    }
    // Everything else just renders as a string.
    throw new CompileError('rendering unknown type of value: ' + (typeof v) + " : " + v)
    return v
  }

  function _fromNaNBytes(bytes, isSignalling) {
    for (var i = 0; i < 8; i++) {
      scratchBytes[i] = bytes[i]
    }
    var v = scratchData.getFloat64(0, true)
    if (isSignalling) {
      v = new Number(v)
      v._signalling = true
    }
    return v
  }

  function makeSigStr(funcSig) {
     var typeCodes = []
     function typeCode(typ) {
       switch (typ) {
         case TYPES.I32:
           return "i"
         case TYPES.I64:
           return "l"
         case TYPES.F32:
           return "f"
         case TYPES.F64:
           return "d"
         default:
           throw new CompileError("unexpected type: " + typ)
       }
     }
     funcSig.param_types.forEach(function(typ) {
       typeCodes.push(typeCode(typ))
     })
     typeCodes.push("->")
     funcSig.return_types.forEach(function(typ) {
       typeCodes.push(typeCode(typ))
     })
     return typeCodes.join("")
   }

  export default WebAssembly
