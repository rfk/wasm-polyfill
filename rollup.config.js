
import commonjs from 'rollup-plugin-commonjs'
import nodeResolve from 'rollup-plugin-node-resolve'
import uglify from 'rollup-plugin-uglify'

export default {
  moduleName: 'WebAssembly',
  entry: 'src/index.js',
  dest: 'wasm-polyfill.min.js',
  format: 'umd',
  plugins: [
    nodeResolve({
      module: true,
      browser: true
    }),
    commonjs(),
    uglify()
  ]
}
