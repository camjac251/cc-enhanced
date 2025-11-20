.PHONY: install clean patch patch-latest diff inspect help

help:
	@echo "Claude Code Patcher (Node.js)"
	@echo ""
	@echo "Usage:"
	@echo "  make install         Install dependencies"
	@echo "  make patch V=2.0.47  Download and patch specific version"
	@echo "  make patch-latest    Download and patch latest version"
	@echo "  make diff V=2.0.47   Compare original vs patched version"
	@echo "  make inspect V=2.0.47 Q=\"search term\"  Search AST in patched file"
	@echo "  make clean           Remove output directories"

install:
	pnpm install

patch:
	@if [ -z "$(V)" ]; then echo "Error: Version V=... required"; exit 1; fi
	pnpm cli -v $(V) --out-dir versions

patch-latest:
	pnpm cli --latest 1 --out-dir versions

diff:
	@if [ -z "$(V)" ]; then echo "Error: Version V=... required"; exit 1; fi
	# Generate clean version for comparison
	pnpm cli -v $(V) --out-dir versions-clean --no-patch
	# Run diff
	pnpm diff diff versions-clean/$(V)/package/cli.js versions/$(V)/package/cli.js

inspect:
	@if [ -z "$(V)" ]; then echo "Error: Version V=... required"; exit 1; fi
	@if [ -z "$(Q)" ]; then echo "Error: Query Q=\"...\" required"; exit 1; fi
	pnpm inspect search versions/$(V)/package/cli.js "$(Q)"

clean:
	rm -rf versions versions-clean test-output test-output-clean
