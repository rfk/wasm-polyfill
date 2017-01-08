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
import translate from "./translate/index"
import { compileAsync, compileSync} from "./compile"
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
  _translate: translate,
  _fromNaNBytes: _fromNaNBytes,
  _dump: dump
}


function validate(bytes) {
  try {
    compileSync(bytes)
  } catch (err) {
    if (err instanceof CompileError) {
      return false
    }
    throw err
  }
  return true
}

function compile(bytes) {
  return compileAsync(bytes).then(function (r) {
    return new Module(r)
  })
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
