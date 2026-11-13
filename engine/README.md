# MASKED's RGB engine

MASKED's RGB engine is UTEXO's [rgb-lib-wasm](https://github.com/UTEXO-Protocol/rgb-lib-wasm) `v1.0.0-beta.4` (MIT):
RGB 0.11.2 and transfer server protocol 1.0 (the protocol UniSat 1.8 and current rgb-lib wallets use). On top of it,
[`masked-b4.patch`](masked-b4.patch) adds:

**Peer-to-peer swaps and Instant (pre-signed) listings**

| Function | What it does |
| --- | --- |
| `wallet.colorSwap(online, psbt, assetId, amount, invoice, sealVout, sealSats, minConf, senderEndpoint, blinding)` | The seller colours a swap PSBT through the same path as `sendBegin`, on a transaction it didn't build, as a donation; `sendEnd` broadcasts it. A protocol 1.0 invoice gets the consignment posted by `sendEnd`, the seal blinding derived from both parties' keys. A bare recipient ID (no servers) is delivered by the caller, with `blinding` |
| `wallet.pendingConsignment(txid, assetId)` | The consignment of a transfer begun and not sent yet, for the buyer to check |
| `WasmWallet.newSwapPsbt(inputs, outputs)`, `verifySwapPsbt(psbt, inputs, outputs, feeSats)` | An unsigned swap PSBT (OP_RETURN at output 0); refuses any change of input, output, amount or fee before signing |
| `WasmWallet.psbtOutpoints(psbt)`, `psbtTxid(psbt)`, `witnessSealScript(invoice)`, `psbtExtractHex(psbt)` | Read a PSBT and an invoice |
| `inspectSwapConsignment(bytes, txid, network, sealVout)` | Checks a consignment before its transaction exists; returns `contractId` and what it assigns to the seal |
| `wallet.presignSale(online, assetId, amount, outpoint, payoutScript, priceSats, minConf)` | Instant listing: a template (input 0 a placeholder for the buyer's coin, input 1 the seller's output; outputs 0 OP_RETURN, 1 payout, 2 the buyer's 330-sat seal), input 1 signed SIGHASH_SINGLE\|ANYONECANPAY. Refuses an output holding anything but exactly `amount` of this asset |
| `wallet.setReservedOutpoints(list)`, `wallet.markOutpointSpent(outpoint)` | Outputs promised to listings are never used for sends, change or receives; a sold one leaves the balance |
| `WasmWallet.presignedListingInfo(psbt)`, `presignedBuyPsbt(template, inputs, sealScript, change)`, `checkPresignedFinal(template, txHex, sealScript)`, `completePresignedConsignment(bytes, templateTxid, txHex)` | The buyer's side: check the listing, build and check its transaction, and the consignment with the final transaction |
| `wallet.setPresignedReceives(recipientIds)` | The buyer posts a bought listing's consignment to its own protocol 1.0 invoice; the seller made the seal before the buyer was known, so these invoices match the seal without the derived blinding |

`sendEnd` also broadcasts a transaction with an input that isn't the wallet's (the other side of a swap).

**RGB 0.11.1 wallets and data**

| What | How |
| --- | --- |
| Incoming transfers in the old (V0) format | Converted to V1 on arrival (rgb-ops `legacy`), fetching any witness transaction named only by its txid. MASKED users who haven't updated and the Launchpad escrow can still send to an upgraded wallet |
| `migrateLegacyWallet(walletDataJson, indexerUrl)` | Upgrades the wallet the previous engine (beta.3) saved, before `WasmWallet.create` opens it: the RGB history, balances and indexes go into the new store (as rgb-lib's own `migrate_rgb_fs_to_db` does for its files), the database gets its new columns, transfers still waiting on the 0.2 protocol are failed (freeing what they held), the bitcoin side is kept or rebuilt by a full scan. The old copy stays in IndexedDB. `create` runs it too, without network |
| `wallet.restoreBackup(bytes, password)`, `wallet.restoreBackupOnline(bytes, password, indexerUrl)` | Also restore a backup the previous engine made (MASKED 2.28 and older), converted the same way; one naming an old witness transaction only by its txid needs the online call, which fetches it |
| `engineFeatures()` | `["swap", "presign", "proxy-v1", "legacy-migration", "legacy-consignments", "legacy-backup"]` |

Not in this version: NFTs (UDA); beta.4 has no UDA schema yet (the previous patch, `masked-uda.patch`, is in the git
history for when it does).

Native tests (in `engine/build.sh`): the whole library, including `swap_`, `presigned` and `legacy_` (a snapshot
written by beta.3's own code is converted and its token and balance checked).

## Build

On a Mac: `brew install llvm` once, Rust from [rustup.rs](https://rustup.rs), then

```sh
bash engine/build.sh     # 10–20 minutes the first time
npm run build            # uses vendor/rgb-lib-wasm automatically
```

Or on GitHub: Actions → **RGB engine** → Run workflow, download the `rgb-lib-wasm` artifact into
`vendor/rgb-lib-wasm/`, then `npm run build`.

`engine/build.sh` checks out the exact upstream commit, applies the patch, runs the tests and builds. Without
`vendor/rgb-lib-wasm`, `npm run build` uses the npm engine (no swaps, listings or wallet upgrade).
