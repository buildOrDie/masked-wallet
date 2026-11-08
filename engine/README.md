# RGB engine with swaps

MASKED's RGB engine is UTEXO's [rgb-lib-wasm](https://github.com/UTEXO-Protocol/rgb-lib-wasm) `v1.0.0-beta.3`
(MIT), the same version MASKED ships from npm, plus [`masked-swap.patch`](masked-swap.patch), which adds peer-to-peer
swaps:

| Function | What it does |
| --- | --- |
| `wallet.colorSwap(online, psbt, assetId, amount, recipientId, sealVout, sealSats, endpoints, minConf)` | The seller colours a swap PSBT: the same path as `sendBegin`, on a transaction it didn't build, recorded as a donation. `sendEnd` broadcasts it later |
| `wallet.pendingConsignment(txid, assetId)` | The consignment of a transfer begun and not sent yet, for the buyer to check |
| `WasmWallet.newSwapPsbt(inputs, outputs)` | An unsigned swap PSBT, OP_RETURN at output 0 |
| `WasmWallet.verifySwapPsbt(psbt, inputs, outputs, feeSats)` | Refuses any change of input, output, amount or fee, before signing |
| `WasmWallet.psbtOutpoints(psbt)`, `psbtTxid(psbt)`, `witnessSealScript(invoice)` | Read a PSBT and an invoice |
| `validateConsignmentOffchain(bytes, txid, network, sealVout?)` | Also returns `contractId` and, with a seal output, `sealAmount` |

It also lets `sendEnd` broadcast a transaction with an input that isn't the wallet's (the other side of a swap).
The patch changes nothing else, so wallets made with the npm engine open unchanged.

## Build

On a Mac: `brew install llvm` once, Rust from [rustup.rs](https://rustup.rs), then

```sh
bash engine/build.sh     # 10–20 minutes the first time
npm run build            # uses vendor/rgb-lib-wasm automatically
```

Or on GitHub: Actions → **RGB engine** → Run workflow, download the `rgb-lib-wasm` artifact into
`vendor/rgb-lib-wasm/`, then `npm run build`.

`engine/build.sh` checks out the exact upstream commit, applies the patch, runs the swap unit tests and builds.
Without `vendor/rgb-lib-wasm`, `npm run build` uses the npm engine and the swap requests say MASKED needs an update.
