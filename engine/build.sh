#!/usr/bin/env bash
# Build MASKED's RGB engine: UTEXO's rgb-lib-wasm v1.0.0-beta.4 (RGB 0.11.2, transfer server protocol 1.0) plus
# masked-b5.patch: peer-to-peer swaps (colorSwap, newSwapPsbt, verifySwapPsbt, …), pre-signed listings
# (presignSale, presignedBuyPsbt, setPresignedReceives, …), several listings bought in one transaction
# (presignedCombinedBuy), every lot of a listing in lots made by one transaction (setSwapLots), lots signed at once (setOwnUnconfirmed: outputs of
# this wallet's own unconfirmed moves can be moved and listed; setSwapChangeVout: a move keeps the rest of the
# tokens on its own change output), spare RGB outputs freed back to bitcoin (spareUtxos, freeSpareUtxosBegin),
# transfers from RGB 0.11.1 wallets (old-format
# consignments converted on arrival) and the upgrade of wallets saved by MASKED's previous engine
# (migrateLegacyWallet). Output: vendor/rgb-lib-wasm/, which `npm run build` uses instead of the npm package.
#
# Needs: git, Rust (rustup) with the wasm32 target, wasm-pack 0.14, and a C compiler that targets WebAssembly
# (on a Mac: `brew install llvm`; Apple's own clang can't). 10–20 minutes the first time.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/.." && pwd)"
tag=v1.0.0-beta.4
commit=f0e266f039744896baa39e3a35766ef01c0f369a
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
git -C "$work" apply "$here/masked-b5.patch"
# swaps, listings, the wallet upgrade and the engine's own tests, natively
(cd "$work" && cargo test --locked --lib -q)
# no paths of this computer in the published engine: Rust and C keep source paths for error messages, and those
# started with /Users/<name>/ (the home folder, the cargo cache, this build folder)
export RUSTFLAGS="--remap-path-prefix=$work=/rgb-lib-wasm --remap-path-prefix=$HOME=/build"
export CFLAGS_wasm32_unknown_unknown="-ffile-prefix-map=$work=/rgb-lib-wasm -ffile-prefix-map=$HOME=/build"
(cd "$work/bindings/wasm" && wasm-pack build --release --target web --out-dir pkg)
if LC_ALL=C grep -a -q -F "$HOME" "$work/bindings/wasm/pkg/rgb_lib_wasm_bindings_bg.wasm"; then echo "The built engine still names $HOME. Stop."; exit 1; fi

out="$root/vendor/rgb-lib-wasm"; rm -rf "$out"; mkdir -p "$out"
cp "$work/bindings/wasm/pkg/"rgb_lib_wasm_bindings* "$out/"
# the bindings import small JS helpers from snippets/ (beta.4: a no-store fetch)
[[ -d "$work/bindings/wasm/pkg/snippets" ]] && cp -R "$work/bindings/wasm/pkg/snippets" "$out/"
node -e "require('fs').writeFileSync('$out/package.json', JSON.stringify({name:'@utexo/rgb-lib-wasm',version:'1.0.0-beta.4+masked',type:'module',main:'rgb_lib_wasm_bindings.js',types:'rgb_lib_wasm_bindings.d.ts'},null,2))"
for f in newSwapPsbt presignSale setSwapLots outputLocks releaseUnbroadcast colorP2pSwap publishP2pSwap p2pCommit setSwapHolds heldSwap releaseSwapHold p2pCompletePsbt p2pPsbtHash presignedCombinedBuy checkPresignedCombinedFinal migrateLegacyWallet setPresignedReceives setOwnUnconfirmed setSwapChangeVout spareUtxos emptyUtxos freeSpareUtxosBegin unpaidWitnessReceives ownMovesChain learnOwnOutputs setLightSync; do
  grep -q "$f" "$out/rgb_lib_wasm_bindings.d.ts" || { echo "The built engine has no $f. Stop."; exit 1; }
done
shasum -a 256 "$out/rgb_lib_wasm_bindings_bg.wasm"
echo "Engine (beta.4 + MASKED) in vendor/rgb-lib-wasm. Now: npm run build"
