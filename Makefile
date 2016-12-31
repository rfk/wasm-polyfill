
NODE = node --harmony --harmony-default_parameters
WASM = ./spec/interpreter/wasm
TESTS = *.wast

.PHONY: test
test: $(WASM)
	for NM in `ls ./spec/interpreter/test/$(TESTS) | grep -v '\.fail\.'`; do  echo "TESTING "`basename $$NM` ; $(WASM) -d $$NM -o test.tmp.in.js; echo "WebAssembly = require('./wasm');\n\nfunction print() { for (var i = 0; i < arguments.length; i++) { console.log(arguments[i]) } }\n" > test.tmp.js ;  sed 's/soft_validate = true/soft_validate = false/g' test.tmp.in.js >> test.tmp.js ; rm test.tmp.in.js ; $(NODE) test.tmp.js > test.tmp.out || exit 1 ; if [ -f ./spec/interpreter/test/expected-output/`basename $$NM`.log ]; then cat ./spec/interpreter/test/expected-output/`basename $$NM`.log | cut -d ' ' -f 1 | cut -d '.' -f 1 > test.tmp.expect ; if diff test.tmp.out test.tmp.expect; then true ; else echo "  OUTPUT MISMATCH!"; exit 1 ; fi ; fi ; echo "  OK!" ; done;

$(WASM): 
	cd ./spec/interpreter && make


retest:
	$(NODE) test.tmp.js > test.tmp.out || exit 1 ; if [ -f ./spec/interpreter/test/expected-output/`basename $$NM`.log ]; then cat ./spec/interpreter/test/expected-output/`basename $$NM`.log | cut -d ' ' -f 1 | cut -d '.' -f 1 > test.tmp.expect ; if diff test.tmp.out test.tmp.expect; then true ; else echo "  OUTPUT MISMATCH!"; exit 1 ; fi ; fi ; echo "  OK!" ;
