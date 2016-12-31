//
// The top-level `WebAssembly` object.
//
// This exposes an object mimicing, as closely as we can,
// the nascent `WebAssembly` javascript API described at
//
//    http://webassembly.org/docs/js
//
// You can use it to instantiate binary WebAssembly code
// into runnable JavaScript objects, although you'll likely
// be disappointed with the performance compared to a native
// browser implementation...
//

import Long from "long"

import Module from "./Module"
import Instance from "./Instance"
import Table from "./Table"
import Memory from "./Memory"
import { CompileError, LinkError, RuntimeError } from "./errors"
import { dump, _fromNaNBytes } from "./utils"


export default WebAssembly

var WebAssembly = {
  Module: Module,
  Instance: Instance,
  Memory: Memory,
  Table: Table,
  CompileError: CompileError,
  LinkError: LinkError,
  RuntimeError: RuntimeError,
  compile: compile,
  instantiate: instantiate,
  validate: validate,

  // Some private things for our own convenience
  _Long: Long,
  _fromNaNBytes: _fromNaNBytes,
  _dump: dump
}


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
  // The parsing and compilation here is synchronous, but we return
  // a promise for API consistency.  If we move it to being asynchronous
  // then it's important that we (semantically) operate on a copy of
  // the state of bytes at the time this function was called.
  try {
    return Promise.resolve(new Module(bytes))
  } catch (err) {
    return Promise.reject(err)
  }
}

function instantiate(bytesOrModuleObject, importObject) {
  if (bytesOrModuleObject instanceof Module) {
    return new Promise(function(resolve) {
      resolve(new Instance(bytesOrModuleObject, importObject))
    })
  }
  return compile(bytesOrModuleObject).then(function(m) {
    return instantiate(m, importObject).then(function(i) {
      return {module: m, instance: i}
    })
  })
}
