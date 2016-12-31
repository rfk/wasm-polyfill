
fs = require('fs')
var WebAssembly = require('./wasm')

buf = fs.readFileSync(process.argv[2])
data = new Uint8Array(buf)
m = new WebAssembly.Module(data)
console.log(m._internals.jsmodule.toString())
