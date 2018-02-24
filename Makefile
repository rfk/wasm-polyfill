
.PHONY: all
all: wasm-polyfill.min.js webextension

# This uses rollup to make a single-file bundle,
# then lightly hacks it to avoid clobbering an existing WebAssembly global.
wasm-polyfill.min.js: src/*.js src/translate/*.js node_modules/long/package.json rollup.config.js
	./node_modules/.bin/rollup -c
	sed -i 's/\([a-z]\+\)\.WebAssembly *= *\([a-z]\+\)()/\1.WebAssembly=\1.WebAssembly||\2()/' wasm-polyfill.min.js

spec/interpreter/README.md:
	git submodule update --init

spec/interpreter/wasm: spec/interpreter/README.md .git/modules/spec/*
	cd ./spec/interpreter && make

node_modules/long/package.json:
	npm install

.PHONY: webextension
webextension: ./webextension/wasm-polyfill.min.js

./webextension/wasm-polyfill.min.js: wasm-polyfill.min.js
	cp ./wasm-polyfill.min.js ./webextension/wasm-polyfill.min.js

.PHONY: test
test: wasm-polyfill.min.js spec/interpreter/wasm
	 ./node_modules/.bin/mocha --timeout 10000 ./tests/

.PHONY: test-bail
test-bail: wasm-polyfill.min.js spec/interpreter/wasm
	 ./node_modules/.bin/mocha --timeout 10000 --bail ./tests/
