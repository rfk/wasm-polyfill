//
// A little helper object for reading primitive values
// out of the bytestream.  One day we might refactor this
// to support e.g. proper streaming reads, but for now
// it's just a nice abstraction.
//

import Long from "long"

import { CompileError } from "../errors"


export default function InputStream(bytes) {
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
  // XXX TODO: we can probably avoid explicitly checking this on every byte...
  if (this.idx >= this.bytes.length) {
    throw new CompileError("unepected end of bytes")
  }
  var b = this.bytes[this.idx++]|0
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
