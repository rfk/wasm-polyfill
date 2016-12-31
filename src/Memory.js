//
// The `Memory` object.
//
// We do the best we can to immitate the growable memory objects
// from WASM on top of normal ArrayBuffers.
//
// Of particular interest here, is the use of `_onChange` callbacks
// to trigger reconstruction of the memory state of any linked
// Instances.  We expect changes to be rare so it seems valuable
// to have the Instance take a local reference to the bufer and
// replace it when necessary, rather than always dereferencing it
// afresh from the Memory object.
//

import { PAGE_SIZE } from "./constants"
import {
  assertIsDefined,
  assertIsInstance,
  assertIsType,
  ToNonWrappingUint32
} from "./utils"


export default function Memory(memoryDescriptor) {
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

//
// Register a callback to be executed when the underlying
// memory buffer changes.
//
// XXX TODO: can we use weakrefs for this, to avoid
// the Memory keeping all connected instances alive?
// I suspect not, but worth investigating.
//
Memory.prototype._onChange = function _onChange(cb) {
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
  var oldSize = this._internals.current
  delta = ToNonWrappingUint32(delta)
  if (delta > 65536) {
    return -1
  }
  var newSize = oldSize + delta
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
