# RGB Signet lab

Settings → **RGB** offers two test networks. Each has its own test keys, data, password and backups; neither touches the normal MASKED wallet.

| | Public Signet (default) | Utexo Signet |
|---|---|---|
| Chain | Public Bitcoin Signet, the same as MASKED's Signet | Utexo's own Signet (`signetcustom`) |
| Indexer | `mempool.space/signet/api` | `esplora-api.utexo.com` |
| RGB transfer proxy | `proxy.iriswallet.com/0.2/json-rpc` | `rgb-proxy.utexo.com/json-rpc` |
| Test BTC | Any Signet faucet, or your MASKED Signet Public balance | `/getbtc` at [Utexo's faucet](https://t.me/Utexo_RLN_bot) |
| Test asset | Create your own (Settings → RGB → Create a test asset) | `/getasset` at the faucet |

No USDT exists on either. USDT on Bitcoin uses the BFA asset type, which Utexo's browser libraries do not list yet.

## Public Signet in 5 steps

1. Select Signet. Settings → RGB → **Public Signet**, set a password (12+ characters), **Enable RGB test assets**, export the backup.
2. Copy the RGB funding address and send it ~20,000 Signet sats (from your MASKED Signet Public balance works). Wait for a block, then **Refresh**.
3. **Prepare RGB outputs**, export a fresh backup.
4. **Create a test asset** (e.g. `TUSDT`, 2 decimals, 1,000,000 supply). Copy its asset ID, export a backup.
5. In a second browser profile, create another test wallet and a blinded invoice for that asset ID, then send from the first one.

## Utexo Signet (original lab)

Select **Signet** in the existing MASKED network settings. Enable **RGB** in Settings. RGB assets appear on the existing Wallet home screen alongside the normal Public/Shielded BTC wallet. Their Receive and Send actions use the existing Receive and Send screens; there is no second wallet page or iframe.

**Network distinction:** MASKED's BTC Signet uses public Bitcoin Signet (`mempool.space/signet`). The SDK's `utexo` network is Utexo's custom Signet (`signetcustom` in the SDK). UI integration does not merge those chains or their coins. RGB funding uses its explicitly labelled Utexo address, independent encrypted test keys, RGB state and backup. Public and BIP352 Shielded BTC balances and address generation stay unchanged. RGB assets are not BIP352-shielded.

Use the existing full extension tab or side panel for long-running operations; closing a popup destroys its runtime.

## First run

1. Run `npm ci`, `npm run check`, and `npm run build`; load/reload `extension/` as an unpacked Chrome extension.
2. Select Signet, open Settings → RGB and enable test assets with a password of at least 12 characters. A new recovery phrase is generated locally, independent of the normal MASKED wallet.
3. Export the encrypted backup and confirm you saved it. Keep the password separately.
4. Send `/getbtc` plus the displayed address to [Utexo's Signet faucet](https://t.me/Utexo_RLN_bot). Wait for confirmation, then Refresh.
5. Export a fresh backup if requested, create RGB outputs (spends test BTC), and export another backup.
6. Create a blinded receive invoice; asset ID may be left blank for the first receive. Export a backup. Request a test asset with `/getasset` and the full invoice, then Refresh.
7. Use an RGB asset’s Send action on Wallet home, or Receive RGB for the first receive. Read the asset ID from your RGB invoice/asset data. The send form uses **integer base units**, not displayed token units. Review and confirm the transfer explicitly, then export a new backup.

A token's ticker does not certify authentic USDT. No production USDT identifier is hardcoded.

## Recovery test

Use a clean Chrome profile with the same unpacked extension. Select your latest exported backup and enter its original password. Restore executes after local SDK initialization and before unlock/sync. Verify balances and transfer history, then send a small test amount. Only one active copy of this test wallet should be used; do not keep the original profile writing to the same state while testing the restored one.

The file contains both the test mnemonic and RGB backup bytes inside a password-encrypted AES-GCM envelope. The normal MASKED vault (`wren.vault`), wallet network and BTC/inscription accounts are not modified. No seed-only recovery is offered, because the RGB state must also be restored. VSS cloud backup is explicitly disabled in this first integration.

The wallet uses a Web Lock to prevent two simultaneous writers in the same extension origin, serializes WASM calls, and uses the existing MASKED lock and auto-lock lifecycle. It does not coordinate independent Chrome profiles/devices; use the recovery procedure above.

## Dependencies and build

- The RGB engine is `@utexo/rgb-lib-wasm` (pinned `1.0.0-beta.3`): on-chain RGB only (issue NIA/IFA, blinded and witness receive, send, encrypted backup), with its state in IndexedDB. MASKED talks to it through `src/rgb/LiteWallet.mjs`, which signs with the engine's own keys.
- It replaced `@utexo/rgb-sdk-web`, which also bundles an RGB Lightning node and a second wallet engine (BDK): the extension went from about 28 MB to about 14 MB. No Lightning; RGB over Lightning is not on mainnet before Q1 2027.
- `npm run build` shrinks the engine with binaryen's `wasm-opt -Oz` (devDependency, pinned), limited to WebAssembly features Chrome supports, and checks that the result still loads. The result is cached in `node_modules/.cache/masked-rgb`, so only the first build takes about 2 minutes.
- Host permissions: `https://esplora-api.utexo.com/*`, `https://rgb-proxy.utexo.com/*` and `https://proxy.iriswallet.com/*` (mempool.space was already allowed). No Lightning or cloud-backup endpoints are used.
- The engine loads only when RGB is turned on; for everyone else the wallet is unchanged.

## Verification and remaining work

Automated checks cover encrypted backup/restore, large backup encoding, Signet-only sends, blinded invoices, asset matching, exact amounts, serial execution and dirty-backup tracking. The repository's lint/type checks and existing wallet/trade/vector tests pass, and the unpacked extension builds.

A real Chrome-extension installation, actual SDK runtime initialization, faucet-funded send/receive, clean-profile restore and network-reconnection behaviour still require manual testing. No live transaction was signed or broadcast during development. The supplied environment has no Chromium binary. Keep the PR as a draft until those checks pass; no store update or production deployment is included.

Reference: [Utexo Web SDK](https://docs.utexo.com/sdk/web-sdk) and [Web quickstart](https://docs.utexo.com/getting-started/quickstart/web).
