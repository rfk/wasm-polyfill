//
// Ahead-of-time translate a .wasm file to JS.
// The JS can't run by itself without all of the
// other runtime support stuff provided by this
// module, but it's handy for testing/debugging.
// 
// Usage:  node ./bin/translate.js filename.wasm
//


fs = require('fs')
var WebAssembly = require('./wasm-polyfill.min.js')

buf = fs.readFileSync(process.argv[2])
data = new Uint8Array(buf)
m = new WebAssembly.Module(data)

// XXX TODO: Module should probably grow an interface for
// this rather than just stringifying the function...
process.stdout.write(m._internals.jsmodule.toString())
