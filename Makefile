
.PHONY: all
all: wasm-polyfill.min.js webextension

wasm-polyfill.min.js: src/*.js node_modules/long/package.json
	./node_modules/.bin/rollup -c

spec/interpreter/README.md:
	git submodule update --init

spec/interpreter/wasm: spec/interpreter/README.md
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
