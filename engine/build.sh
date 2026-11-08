#!/usr/bin/env bash
# Build MASKED's RGB engine: UTEXO's rgb-lib-wasm v1.0.0-beta.3 (the version MASKED ships) plus masked-swap.patch
# (peer-to-peer swaps: swapBegin, buildSwapPsbt, checkSwapPsbt, …). Output: vendor/rgb-lib-wasm/, which
# `npm run build` uses instead of the npm package.
#
# Needs: git, Rust (rustup) with the wasm32 target, wasm-pack 0.14, and a C compiler that targets WebAssembly
# (on a Mac: `brew install llvm`; Apple's own clang can't). 10–20 minutes the first time.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/.." && pwd)"
tag=v1.0.0-beta.3
commit=5e38cfb1282d6067ebcdf741f32cf8cccbd654ab
work="$here/.build/rgb-lib-wasm"

command -v cargo >/dev/null || { echo "Install Rust first: https://rustup.rs"; exit 1; }
rustup target add wasm32-unknown-unknown >/dev/null
command -v wasm-pack >/dev/null || cargo install wasm-pack@0.14.0
if [[ "$(uname)" == "Darwin" ]]; then
  llvm="$(brew --prefix llvm 2>/dev/null || true)"
  [[ -x "$llvm/bin/clang" ]] || { echo "Install LLVM first: brew install llvm"; exit 1; }
  export CC_wasm32_unknown_unknown="$llvm/bin/clang" AR_wasm32_unknown_unknown="$llvm/bin/llvm-ar"
fi

rm -rf "$work"; mkdir -p "$(dirname "$work")"
git clone --quiet --depth 1 --branch "$tag" https://github.com/UTEXO-Protocol/rgb-lib-wasm.git "$work"
[[ "$(git -C "$work" rev-parse HEAD)" == "$commit" ]] || { echo "Upstream $tag is not $commit any more. Stop."; exit 1; }
git -C "$work" apply "$here/masked-swap.patch"
(cd "$work" && cargo test --locked --lib swap_ -q)            # the swap PSBT checks, natively
(cd "$work/bindings/wasm" && wasm-pack build --release --target web --out-dir pkg)

out="$root/vendor/rgb-lib-wasm"; rm -rf "$out"; mkdir -p "$out"
cp "$work/bindings/wasm/pkg/"rgb_lib_wasm_bindings* "$out/"
node -e "require('fs').writeFileSync('$out/package.json', JSON.stringify({name:'@utexo/rgb-lib-wasm',version:'1.0.0-beta.3+masked-swap',type:'module',main:'rgb_lib_wasm_bindings.js',types:'rgb_lib_wasm_bindings.d.ts'},null,2))"
grep -q buildSwapPsbt "$out/rgb_lib_wasm_bindings.d.ts" || { echo "The built engine has no swap functions. Stop."; exit 1; }
shasum -a 256 "$out/rgb_lib_wasm_bindings_bg.wasm"
echo "Engine with swaps in vendor/rgb-lib-wasm. Now: npm run build"
