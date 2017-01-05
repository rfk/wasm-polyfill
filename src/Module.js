//
// The `Module` object.
//
// This object coordinates parsing the WASM bytecode
// and providing it for linking as live function objects.
// It also lets you introspect some details of the module
//

import { assertIsDefined, assertIsInstance } from "./utils"
import { EXTERNAL_KIND_NAMES, SECTIONS } from "./constants"
import { compileSync } from "./compile"


export default function Module(bytesOrCompiledModule) {
  assertIsDefined(this)
  if (typeof bytesOrCompiledModule.jsmodule === "undefined") {
    this._compiled = compileSync(bytesOrCompiledModule)
  } else {
    this._compiled = bytesOrCompiledModule
  }
}

Module.exports = function exports(moduleObject) {
  assertIsInstance(moduleObject, Module)
  return this._compiled.exports.map(function(e) {
    return {
      name: e.field, // XXX TODO: convert from utf8
      kind: EXTERNAL_KIND_NAMES[e.kind]
    }
  })
}

Module.imports = function imports(moduleObject) {
  assertIsInstance(moduleObject, Module)
  return this._compiled.imports.map(function(i) {
    return {
      module: i.module_name, // XXX TODO: convert from utf8
      name: i.item_name, // XXX TODO: convert from utf8
      kind: EXTERNAL_KIND_NAMES[i.kind]
    }
  })
}

Module.customSections = function imports(moduleObject, sectionName) {
  assertIsInstance(moduleObject, Module)
  throw new RuntimeError('customSections not implemented yet')
}
