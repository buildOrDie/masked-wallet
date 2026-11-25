# MASKED's RGB engine

MASKED's RGB engine is UTEXO's [rgb-lib-wasm](https://github.com/UTEXO-Protocol/rgb-lib-wasm) `v1.0.0-beta.4` (MIT):
RGB 0.11.2 and transfer server protocol 1.0 (the protocol UniSat 1.8 and current rgb-lib wallets use). On top of it,
[`masked-b5.patch`](masked-b5.patch) adds:

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
| `wallet.setOwnUnconfirmed(txids)` | Lots signed at once: outputs of these transactions (this wallet's own listing and lot moves, still unconfirmed) can be moved, listed and cancelled before they confirm. Only a transaction the wallet has and funded with an output of its own counts; tokens received from others still wait for their confirmations. A buyer of such a listing gets the tokens once the moves confirm (the engine waits for an unconfirmed history by itself) |
| `wallet.setSwapChangeVout(vout)` | For the next `colorSwap` only: the rest of the tokens go on output `vout` of its PSBT (this wallet's own change output, moved to its RGB side if needed) instead of a free RGB output elsewhere. A move then needs no free RGB output, and the next lot of a chain moves from it at once |
| `wallet.ownMovesChain()` | `true`: the change of this wallet's own unconfirmed move (named with `setOwnUnconfirmed`) can be moved again before this wallet took the move in as its receiver, which it can only do once the moves before it confirm. So lots chain at once, any number deep |
| `wallet.learnOwnOutputs()` | Records the RGB-side outputs of this wallet's own transactions just broadcast (already in its graph) without asking the block server. A sync asks it about every address the wallet ever used |
| `wallet.setLightSync(recent)` | Syncs ask the block server only about the last `recent` addresses of each side, the addresses invoices still wait on and the wallet's unconfirmed transactions (a few dozen requests instead of one per address ever used). A full sync still runs at most every 30 minutes, and on a full scan. `null`: every sync full |
| `wallet.spareUtxos()` | The spare RGB outputs: this wallet's confirmed outputs with nothing on them (no allocation, no blinded receive, not waiting for a witness transfer) and not reserved (an Instant listing, a begun transfer or bitcoin operation). Smallest first, as `txid:vout`. A failed transfer's allocation doesn't count as being on it, and an output waiting for a witness transfer counts when the transaction that made it can't have moved tokens (every input this wallet's, no OP_RETURN: this engine commits only with OP_RETURN) |
| `wallet.emptyUtxos()` | JSON text: every output with no live allocation and why it isn't spare: `[{ outpoint, sats, why }]`, `why` one of `""` (spare), `pending witness`, `blinded receive`, `transfer`, `listing`, `bitcoin operation`, `not broadcast`, `unconfirmed` |
| `wallet.unpaidWitnessReceives()` | Witness receives still waiting for the other side that no transaction known to the wallet pays: their batch transfer indexes. Failing them loses nothing (no output carries them) |
| `wallet.freeSpareUtxosBegin(online, keep, parts, feeRate)` | Keep `keep` spare outputs (the smallest), spend the rest together with the wallet's plain bitcoin into `parts` plain coins of about the same size. Outputs holding tokens never move. Unsigned PSBT; ended with `drainToEnd` |
| `wallet.setPresignedReceives(recipientIds)` | The buyer posts a bought listing's consignment to its own protocol 1.0 invoice; the seller made the seal before the buyer was known, so these invoices match the seal without the derived blinding |

`sendEnd` also broadcasts a transaction with an input that isn't the wallet's (the other side of a swap).

**RGB 0.11.1 wallets and data**

| What | How |
| --- | --- |
| Incoming transfers in the old (V0) format | Converted to V1 on arrival (rgb-ops `legacy`), fetching any witness transaction named only by its txid. MASKED users who haven't updated and the Launchpad escrow can still send to an upgraded wallet |
| `migrateLegacyWallet(walletDataJson, indexerUrl)` | Upgrades the wallet the previous engine (beta.3) saved, before `WasmWallet.create` opens it: the RGB history, balances and indexes go into the new store (as rgb-lib's own `migrate_rgb_fs_to_db` does for its files), the database gets its new columns, transfers still waiting on the 0.2 protocol are failed (freeing what they held), the bitcoin side is kept or rebuilt by a full scan. The old copy stays in IndexedDB. `create` runs it too, without network |
| `wallet.restoreBackup(bytes, password)`, `wallet.restoreBackupOnline(bytes, password, indexerUrl)` | Also restore a backup the previous engine made (MASKED 2.28 and older), converted the same way; one naming an old witness transaction only by its txid needs the online call, which fetches it |
| `wallet.setRefreshSkip(batchTransferIdx[])` | Waiting transfers the next refreshes leave alone, until set again (`[]`: all of them). MASKED passes receives waiting for their transfer data for over a day, asked about hourly instead of on every refresh |
| `wallet.reopenPresignedReceive(recipientId, consignment)` | Opens again a pre-signed purchase this wallet refused (an NFT listed without all its files by MASKED up to 2.32.4): the receive waits for its transfer again, given here, and the next `refresh` validates it from scratch. Files go in first with `addMediaFile`; a file the wallet holds is used before asking the transfer server |
| `engineFeatures()` | `["swap", "presign", "proxy-v1", "legacy-migration", "legacy-consignments", "legacy-backup", "reopen-purchase"]` |

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
