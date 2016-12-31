//
// The `Table` object.
//
// This is a straightforward wrapper around a plain old
// JavaScript array.
//

import {
  assertIsDefined,
  assertIsInstance,
  assertIsType,
  ToNonWrappingUint32
} from "./utils"


export default function Table(tableDescriptor) {
  assertIsDefined(this)
  assertIsType(tableDescriptor, "object")
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
  var oldSize = this.length
  var newSize = oldSize + ToNonWrappingUint32(delta)
  if (newSize < oldSize) {
    throw new RangeError()
  }
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
  if (index >= this._internals.values.length) {
    throw RangeError
  }
  this._internals.values[index] = value
}
