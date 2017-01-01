//
// The WASM "standard library".
//
// These are all the helper functions that we need to have available
// for use by the translated JS code.  They implement various bits of
// the semantics of WASM, which don't seem to be as close to the
// semantics of JS as I would have liked...
//
// Two things of particular interest:
//
//  * We emulate 64-bit integers using a third-party `Long` class.
//    It might be fun to try to write a smaller version with just
//    the bits we need, implemented directly in these helper functions.
//
//  * The float32 functions have a lot of mucking around with NaNs.
//    WASM requires that we preserve specific bit patterns in NaNs
//    and as far as I can tell, JavaScript doesn't do this reliably.
//    In particular, if you write a 32-bit float to an ArrayBuffer
//    and read it back, it will be converted from signalling to
//    non-signalling.
//
//    We work around this for now by boxing NaNs into a Number object
//    and setting a separte flag, but that's very hacking and I'm sure
//    very slow.  It would be great to find a better way...
//

import Long from "long"

import { RuntimeError } from "./errors"
import { dump, _fromNaNBytes } from "./utils"

export default stdlib

var stdlib = {}


// A little scratch space for examining the bits
// of a float, converting float<->int, etc.
var scratchBuf = new ArrayBuffer(8)
var scratchBytes = new Uint8Array(scratchBuf)
var scratchData = new DataView(scratchBuf)

// Helpful constants.
stdlib.INT32_MIN = 0x80000000|0
stdlib.INT32_MAX = 0x7FFFFFFF|0
stdlib.UINT32_MIN = 0x00000000>>>0
stdlib.UINT32_MAX = 0xFFFFFFFF>>>0

// Misc structural functions.
stdlib.trap = function(msg) { var e = new RuntimeError(msg || "it's a trap!") ; throw e };

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
