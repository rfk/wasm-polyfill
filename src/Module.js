//
// The `Module` object.
//
// This object coordinates parsing the WASM bytecode
// and providing it for linking as live function objects.
// It also lets you introspect some details of the module
//

import { assertIsDefined, assertIsInstance } from "./utils"
import { EXTERNAL_KIND_NAMES, SECTIONS } from "./constants"
import parseFromWASM from "./parser"
import renderToJS from "./render"


export default function Module(bufferSource) {
  assertIsDefined(this)
  var bytes = new Uint8Array(arrayBufferFromBufferSource(bufferSource))
  var parsed = parseFromWASM(bytes)
  this._internals = {
    sections: parsed.sections,
    constants: parsed.constants,
    jsmodule: renderToJS(parsed.sections, parsed.constants)
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

