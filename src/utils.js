
//
// Various misc helper functions.
//

import Long from "long"
import { CompileError, RuntimeError } from "./errors"
import { TYPES } from "./constants"
import stdlib from "./stdlib"

export function trap(msg) {
  throw new RuntimeError(msg || "it's a trap!")
}

export function assertIsDefined(obj, Err) {
  Err = Err || TypeError
  if (typeof obj === "undefined") {
    throw new Err()
  }
}

export function assertIsInstance(obj, Cls, Err) {
  Err = Err || TypeError
  if (!(obj instanceof Cls)) {
    throw new Err()
  }
}

export function assertIsType(obj, typstr, Err) {
  Err = Err || TypeError
  if (typeof obj !== typstr) {
    throw new Err()
  }
}

export function assertIsCallable(obj, Err) {
  Err = Err || TypeError
  // XXX TODO: more complicated cases
  if (typeof obj !== "function" ) {
    throw new Err()
  }
}

export function ToWASMValue(jsValue, typ, Err) {
  Err = Err || TypeError
  if (typeof jsValue === "undefined") {
    return 0
  }
  if (typeof jsValue !== 'number' && ! (jsValue instanceof Number)) {
    throw new Err("cant pass non-number in to WASM")
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
      throw new Err("Unknown type: " + typ)
  }
}

export function ToJSValue(wasmValue, typ) {
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

export function ToNonWrappingUint32(v) {
  // XXX TODO: throw RangeError if > UINT32_MAX
  return v >>> 0
}

var scratchBuf = new ArrayBuffer(8)
var scratchBytes = new Uint8Array(scratchBuf)
var scratchInts = new Uint32Array(scratchBuf)
var scratchData = new DataView(scratchBuf)

export function stringifyJSValue(v) {
  // We need to preserve two things that don't round-trip through v.toString():
  //  * the distinction between -0 and 0
  //  * the precise bit-pattern of an NaN
  if (typeof v === "number" || (typeof v === "object" && v instanceof Number)) {
    if (isNaN(v)) {
      if (typeof v === "object") {
        return "WebAssembly._toBoxedNaN(" + stringifyJSValue(v._wasmBitPattern) + ")"
      } else {
        scratchData.setFloat64(0, v, true)
        var low = scratchData.getInt32(0, true)
        var high = scratchData.getInt32(4, true)
        return "WebAssembly._toBoxedNaN(new Long(" + low + ", " + high + "))"
      }
    }
    return "" + (((v < 0 || 1 / v < 0) ? "-" : "") + Math.abs(v))
  }
  // Special rendering required for Long instances.
  if (v instanceof Long) {
    return "new Long(" + v.low + "," + v.high + ")"
  }
  // Quote strings, with liberal escaping for safely.
  if (typeof v === 'string') {
    var quoted = "'"
    for (var i = 0; i < v.length; i++) {
      var c = v.charCodeAt(i)
      // Trivial characters == ASCII printables, above single-quote and below delete,
      // and excluding backslash.  Everything else gets unicode-escaped.
      if (c > 39 && c < 127 && c !== 92) {
        quoted += v.charAt(i)
      } else {
        var escd = c.toString(16)
        while (escd.length < 4) {
          escd = "0" + escd
        }
        quoted += "\\u" + escd
      }
    }
    quoted += "'"
    return quoted
  }
  // We're not expecting anything else.
  throw new CompileError('rendering unknown type of value: ' + (typeof v) + " : " + v)
}

export function _toBoxedNaN(wasmBitPattern) {
  if (typeof wasmBitPattern === "number") {
    scratchData.setInt32(0, wasmBitPattern, true)
    var res = scratchData.getFloat32(0, true)
    if (isNaNPreserving32) {
      return res
    }
  } else {
    scratchData.setInt32(0, wasmBitPattern.low, true)
    scratchData.setInt32(4, wasmBitPattern.high, true)
    var res = scratchData.getFloat64(0, true)
    if (isNaNPreserving64) {
      return res
    }
  }
  res = new Number(res)
  res._wasmBitPattern = wasmBitPattern
  return res
}

export function makeSigStr(funcSig) {
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
   typeCodes.push("_")
   funcSig.return_types.forEach(function(typ) {
     typeCodes.push(typeCode(typ))
   })
   return typeCodes.join("")
}

export function dump() {
  if (typeof process === "undefined" || ! process.stderr) {
    if (typeof console !== "undefined") {
      return console.log.apply(console, arguments)
    }
  }
  for (var i = 0; i < arguments.length; i++) {
    var arg = arguments[i]
    if (typeof arg === 'string') {
      process.stderr.write(arg)
    } else if (typeof arg === 'number' || (arg instanceof Number)) {
      process.stderr.write(stringifyJSValue(arg))
    } else {
      process.stderr.write(JSON.stringify(arg))
    }
    process.stderr.write(' ')
  }
  process.stderr.write('\n')
}

var _filename = undefined;

export function filename() {

  if (_filename) {
    return _filename
  }

  var errlines = new Error().stack.split('\n');
  for (var i = 0; i < errlines.length; i++) {
    var match = /(at .+ \(|at |@)(.+\/.+\.js):/.exec(errlines[i])
    if (match) {
      _filename = match[2]
      return _filename
    }
  }

  throw new RuntimeError("could not determine script filename")
}

export function inherits(Cls, Base, methods) {
  Cls.prototype = Object.create(Base.prototype)
  if (methods) {
    Object.keys(methods).forEach(function(key) {
      Cls.prototype[key] = methods[key]
    })
  }
}

// Feature-detect some subtleties of browser/platform behaviour.

// Are TypedArrays little-endian on this platform?

export var isLittleEndian
scratchInts[0] = 0x0000FFFF
if (scratchBytes[0] === 0xFF) {
  isLittleEndian = true
} else {
  isLittleEndian = false
}

// Does the VM canonicalize 64-bit NaNs?
// V8 doesn't, but SpiderMonkey does.

export var isNaNPreserving64 = false
scratchInts[0] = 0xFFFFFFFF
scratchInts[1] = 0xFFF7FFFF
scratchData.setFloat64(0, scratchData.getFloat64(0, true), true)
if (scratchInts[0] === 0xFFFFFFFF && scratchInts[1] === 0xFFF7FFFF) {
  scratchInts[1] = 0xFFFFFFFF
  scratchData.setFloat64(0, scratchData.getFloat64(0, true), true)
  if (scratchInts[0] === 0xFFFFFFFF && scratchInts[1] === 0xFFFFFFFF) {
    isNaNPreserving64 = true
  }
}

// Does the VM canonicalize 32-bit NaNs?
// It seems that they all do, at least by setting the quiet bit..?

export var isNaNPreserving32 = false
scratchInts[0] = 0xFFBFFFFF
scratchData.setFloat32(0, scratchData.getFloat32(0, true), true)
if (scratchInts[0] === 0xFFBFFFFF) {
  scratchInts[0] = 0xFFFFFFFF
  scratchData.setFloat32(0, scratchData.getFloat32(0, true), true)
  if (scratchInts[0] === 0xFFFFFFFF) {
    isNaNPreserving32 = true
  }
}

