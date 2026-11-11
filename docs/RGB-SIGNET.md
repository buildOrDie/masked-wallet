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

## Using it (Public Signet)

RGB is part of the normal screens, on Signet only:

1. **Home → Try RGB tokens.** RGB turns on. No extra password: its test keys are encrypted with a key derived from your wallet's recovery words (and BIP39 passphrase), and it opens by itself whenever the wallet is open on Signet.
2. **Add test BTC for RGB** (Home). RGB pays its own network fees from its own address; this opens Send, filled in with 0.0003 tBTC from your Public balance. Wait for a block.
3. **Mint → RGB token.** Name, ticker, supply (decimals under *Decimals*, default 2) → **Create token**. The first time, MASKED sets up RGB outputs by itself; if they still need a block, it says so.
4. Your token shows under **RGB tokens** on Home, in the same rows as BRC-20. Its page has **Send** and **Receive**, History and Details.
5. **Receive → RGB** makes a one-time invoice (QR + text). To pay one: the token page → **Send**, paste the invoice, amount in token units → **Confirm**.

**Settings → RGB (test)** has the advanced parts: test network (Public or Utexo Signet), the RGB address, backup file and restore (restoring needs the same MASKED wallet), and turning RGB off.

A test wallet made by an earlier test build (with its own RGB password) asks for that password once, then switches to the wallet key.

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

## Mainnet beta: encrypted cloud backup

On Bitcoin mainnet, RGB tokens can't come back from the recovery phrase alone, so MASKED keeps an encrypted cloud
backup of the RGB state. It is on by default and can be switched off in **Settings → RGB (beta)**; backup files still
work either way.

- **Encrypted before it leaves.** The backup (already encrypted with a key from the recovery phrase) is encrypted again
  with AES-256-GCM using a key derived from the phrase and passphrase (`SHA-256("MASKED/rgb-cloud/v1\n"…)`, then
  HMAC-SHA256 `enc`), padded to fixed sizes, and stored under an ID that is a public key, not an address.
- **Signed.** Each upload is signed with a BIP340 key from the same phrase (HMAC-SHA256 `sign`). The server refuses
  anything not signed by the key its ID names.
- **Versioned.** Every save has a version that only goes up. The server refuses an equal or older version and keeps
  the last three. The version is bound into the encryption, and the browser refuses a backup older than the last one
  it saved. If another browser saved a newer one, MASKED says so and asks before replacing it.
- **Restore.** Turning on RGB in a new browser with the same phrase restores the latest cloud backup. If the server
  can't be reached, MASKED doesn't start a new RGB wallet over a backup that may exist.
- **Switch off.** Switching off sends a signed request that deletes every stored copy. After that, save backup files
  yourself after every change.
- **Signet too (2.27.11).** Each RGB test network has its own backup, on a path of its own
  (`MASKED/rgb-cloud/v1/<network>`), so a Signet backup never touches the mainnet one. New Signet RGB wallets also take
  their keys from the phrase (`MASKED/rgb-<network>-keys/v1`), like mainnet: restoring the phrase in a new browser and
  turning on RGB brings the same wallet back. Signet wallets made before 2.27.11 keep their own keys and start backing up
  to the cloud the next time they change.
- Code: `src/rgb/cloud.mjs`. Endpoint: `https://scan.maskedwallet.com/rgb-vault/v1/backup/<id>`.

What the server can see: when backups are saved, their rough size, and the IP address that saved them. It can't read
tokens, amounts, addresses or keys. Someone who has your recovery phrase can restore your RGB backup, like your BTC.
