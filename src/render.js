//
// Render a parsed WASM module into runnable JavaScript.
//
// This module is the complement to parser.js.  It takes the data structures
// parsed by that module, and renders them into a javascript function that
// looks something like this:
//
//    function (WebAssembly, imports, constants, stdlib) {
//
//      // Local references to helper functions
//      const Long = WebAssembly._Long
//      const i64_eq = stdlib.i64_eq
//      ...etc...
//
//      // Imported functions, globals, etc.
//      var F0 = imports[0]
//      var G0 = imports[1]
//      var F1 = imports[2]
//      ...etc...
//
//      // Local Table and Memory definitions.
//      var T0 = new WebAssembly.Table({ initial: 1024 })
//      var M0 = new WebAssembly.Memory({ initial: 1024, maximum: 2048 })
//
//      // Local views onto the memory ArrayBuffer
//      var memorySize = M0.buffer.byteLength
//      var HI8 = new Int8Array(M0.buffer)
//      var HI16 = new Int16Array(M0.buffer)
//      var HI32 = new Int32Array(M0.buffer)
//      var HU8 = new Uint8Array(M0.buffer)
//      var HU16 = new Uint16Array(M0.buffer)
//      var HU32 = new Uint32Array(M0.buffer)
//      var HF32 = new Float32Array(M0.buffer)
//      var HF64 = new Float64Array(M0.buffer)
//      var HDV = new DataView(M0.buffer)
//
//      // A callback that's executed if the memory changes,
//      // so we can update our local views.
//      var onMemoryChange = function() {
//        memorySize = M0.buffer.byteLength
//        HI8 = new Int8Array(M0.buffer)
//        HI16 = new Int16Array(M0.buffer)
//        HI32 = new Int32Array(M0.buffer)
//        HU8 = new Uint8Array(M0.buffer)
//        HU16 = new Uint16Array(M0.buffer)
//        HU32 = new Uint32Array(M0.buffer)
//        HF32 = new Float32Array(M0.buffer)
//        HF64 = new Float64Array(M0.buffer)
//        HDV = new DataView(M0.buffer)
//      }
//      M0._onChange(onMemoryChange)
//
//      // Global variable definitions.
//      var G1 = 3.1415
//      var G2 = 42
//
//      // The code for each function defined in the module.
//      // The use local variables to simulate the WASM stack,
//      // and frankly don't do a terribly clever job of it.
//      function F2(li0) {
//        var si0 = 0|0
//        var si1 = 0|0
//        si0 = li0
//        si1 = li0
//        si0 = si0 + si1
//        return si0
//      }
//      F2._wasmTypeSigStr = 'i->i'
//      F2._wasJSWrapper = null
//
//      // Insert functions into the table, with bounds-checking.
//      if ((0 + 3 - 1) >= T0.length) { throw new TypeError('table out of bounds') }
//      T[0 + 0] = F0
//      T[0 + 1] = F1
//      T[0 + 2] = F2
//
//      // Initialize memory data, with bounds-checking.
//      if ((32 + 5 + - 1) >= M0.buffer.byteLength) { throw new TypeError('memory out of bounds') }
//      HI8[32 + 0] = 0xAA
//      HI8[32 + 1] = 0xBB
//      HI8[32 + 2] = 0xCC
//      HI8[32 + 3] = 0xDD
//      HI8[32 + 4] = 0xFF
//
//      // Run the `start` function if one is defined.
//      F1()
//
//      // Return an object containing the exported functions.
//      var exports = {}
//      exports['times-two'] = F2
//      return exports
//    }
//
// You might notice that this looks a little like asm.js, and it is, but it's got
// several difference in order to account for the different semantics of WASM,
// in particular around growable memory. It would be interesting to try to make
// this more and more like asm.js in future, for obvious speed benefits.
// 

import stdlib from "./stdlib"
import { dump, renderJSValue } from "./utils"
import { SECTIONS, TYPES, EXTERNAL_KINDS } from "./constants"


export default function renderToJS(sections, constants) {

  //dump("\n\n---- RENDERING CODE ----\n\n")

  // For now, for simplicity, we just build up the strings
  // in an array.  We should probably to try write them to
  // e.g. an ArrayBuffer or something more clever in future.
  var src = []
  function pushLine(ln) {
    ln.split("\n").forEach(function(ln) {
      // Trim whitespace, or we produce something too large
      // to be converted to a single javascript string.
      src.push(ln.trim() + "\n")
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
      // Set in chunks to reduce source string size.
      var chunkStart = 0
      var chunkEnd = Math.min(32, d.data.length)
      while (chunkStart < d.data.length) {
        var items = []
        for (var i = chunkStart; i < chunkEnd; i++) {
          items.push(d.data.charCodeAt(i))
        }
        pushLine("HI8.set([" + items.join(",") + "], (" + d.offset.jsexpr + ") + " + chunkStart + ")")
        chunkStart = chunkEnd
        chunkEnd = Math.min(chunkEnd + 32, d.data.length)
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
  // The code is probably too big to put into a string...
  //pushLine("})")

  var size = 0
  src.forEach(function(ln) {
    size += ln.length + 1
  })
  dump("script source size: ", size)
  var code = src.join("")
  //dump(code)
  //dump("---")
  return new Function("WebAssembly", "imports", "constants", "stdlib", code)
}
