
import commonjs from 'rollup-plugin-commonjs'
import nodeResolve from 'rollup-plugin-node-resolve'
import uglify from 'rollup-plugin-uglify'

export default {
  moduleName: 'WebAssembly',
  entry: 'src/wasm.js',
  format: 'umd',
  dest: 'wasm-polyfill.min.js',
  plugins: [
    nodeResolve({
      module: true,
      browser: true
    }),
    commonjs(),
    uglify()
  ]
}
