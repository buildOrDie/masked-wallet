# RGB Signet lab

Open **Settings → RGB Signet lab** in the rebuilt extension. It opens a full extension tab so the SDK is not interrupted when the normal popup closes. This is an experimental, on-chain RGB test integration on Utexo Signet. It does not provide real USDT, mainnet RGB, Lightning channels or DEX trading.

## First run

1. Run `npm ci`, `npm run check`, and `npm run build`; load/reload `extension/` as an unpacked Chrome extension.
2. Open the lab and create a test wallet with a password of at least 12 characters. A new recovery phrase is generated locally, independent of the normal MASKED wallet.
3. Export the encrypted backup and confirm you saved it. Keep the password separately.
4. Send `/getbtc` plus the displayed address to [Utexo's Signet faucet](https://t.me/Utexo_RLN_bot). Wait for confirmation, then Refresh.
5. Export a fresh backup if requested, create RGB outputs (spends test BTC), and export another backup.
6. Create a blinded receive invoice; asset ID may be left blank for the first receive. Export a backup. Request a test asset with `/getasset` and the full invoice, then Refresh.
7. Read the received asset's exact ID and precision from the Assets response. The send form uses **integer base units**, not displayed token units. Review and confirm the transfer explicitly, then export a new backup.

A token's ticker does not certify authentic USDT. No production USDT identifier is hardcoded.

## Recovery test

Use a clean Chrome profile with the same unpacked extension. Select your latest exported backup and enter its original password. Restore executes after local SDK initialization and before unlock/sync. Verify balances and transfer history, then send a small test amount. Only one active copy of this test wallet should be used; do not keep the original profile writing to the same state while testing the restored one.

The file contains both the test mnemonic and RGB backup bytes inside a password-encrypted AES-GCM envelope. The normal MASKED vault (`wren.vault`), wallet network and BTC/inscription accounts are not modified. No seed-only recovery is offered, because the RGB state must also be restored. VSS cloud backup is explicitly disabled in this first integration.

The page uses a Web Lock to prevent two simultaneous writers in the same extension origin, serializes WASM calls, and auto-locks after five minutes of inactivity. It does not coordinate independent Chrome profiles/devices; use the recovery procedure above.

## Dependencies and build

- `@utexo/rgb-sdk-web` is pinned to `1.0.0-beta.12`. This is a new, beta runtime dependency, included for the requested Utexo integration; it needs review before merge/release.
- `buffer@6.0.3` supplies browser compatibility for the SDK's bitcoinjs dependency. Existing MASKED cryptography dependencies remain pinned and unchanged.
- RGB runs locally with packaged `@utexo/rln-wasm` (four binary chunks reassembled locally) and BDK WASM assets. No remote JavaScript or WASM is loaded. The on-chain page is a separate ESM bundle; the existing popup remains an IIFE.
- Two host permissions are added: `https://esplora-api.utexo.com/*` and `https://rgb-proxy.utexo.com/*`. No LSP, Lightning or cloud-backup endpoints are used.
- The SDK adds approximately 26 MiB of WASM plus the lab bundle. Generated extension files must be committed as required by CONTRIBUTING.md.

The Utexo SDK's default runtime is configured explicitly: `network: 'utexo'`, the hosted Signet Esplora and RGB transport, `proxyUrl: ''`, and `vssUrl: null`. These services may be unavailable or rate limited; a failed connection is shown as an error, not a zero balance.

## Verification and remaining work

Automated checks cover encrypted backup/restore, large backup encoding, Signet-only sends, blinded invoices, asset matching, exact amounts, serial execution and dirty-backup tracking. The repository's lint/type checks and existing wallet/trade/vector tests pass, and the unpacked extension builds.

A real Chrome-extension installation, actual SDK runtime initialization, faucet-funded send/receive, clean-profile restore and network-reconnection behaviour still require manual testing. No live transaction was signed or broadcast during development. The supplied environment has no Chromium binary. Keep the PR as a draft until those checks pass; no store update or production deployment is included.

Reference: [Utexo Web SDK](https://docs.utexo.com/sdk/web-sdk) and [Web quickstart](https://docs.utexo.com/getting-started/quickstart/web).
