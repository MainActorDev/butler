# Vendored grammar WASMs

## tree-sitter-swift.wasm — from tree-sitter-wasms@0.1.8

The swift grammar shipped in tree-sitter-wasms >= 0.1.10 (identical bytes through
0.1.13) aborts Node >= 24 during background wasm tier-up:

    # Fatal process out of memory: Zone
    v8::internal::compiler::turboshaft::WasmLoweringPhase

The parse itself succeeds; the crash fires in the background compile thread, so
any process that loads the module eventually dies (observed on Node 24.12,
web-tree-sitter 0.25.x, macOS arm64; `node --liftoff-only` avoids it but is not
allowed in NODE_OPTIONS). The 0.1.8 build (older, smaller swift grammar) tier-ups
cleanly and extracts the same declaration set. tree-sitter/typescript/tsx/python
from the current pack are unaffected and resolve from `tree-sitter-wasms` at
runtime.

Re-extract when the upstream pack ships a fixed swift build:
    npm pack tree-sitter-wasms@<ver> && tar -xzf … package/out/tree-sitter-swift.wasm
then re-run test/tree-sitter-wasm.test.ts WITHOUT --liftoff-only to prove the
crash is gone before deleting this vendored copy.
