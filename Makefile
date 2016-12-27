
NODE = node --harmony --harmony-default_parameters
WASM = ./spec/interpreter/wasm
TESTS = *.wast

.PHONY: test
test: $(WASM)
	for NM in `ls ./spec/interpreter/test/$(TESTS) | grep -v '\.fail\.'`; do $(WASM) -d $$NM -o test.tmp.in.js; echo "WebAssembly = require('./wasm');" > test.tmp.js ; sed 's/print: print \|\|/print: /g' test.tmp.in.js >> test.tmp.js ; rm test.tmp.in.js ; $(NODE) test.tmp.js || exit 1; rm test.tmp.js ; done;

$(WASM): 
	cd ./spec/interpreter && make


