# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, Devin…) working on this repository.
People: start with [README.md](README.md) and the [guide](docs/README.md).

## What this is

MASKED is an open-source, self-custodial Bitcoin wallet: a Chrome extension (Manifest V3) plus an Android app (Capacitor) built from the same source.
Two balances from one recovery phrase: **Public** (taproot `bc1p…`) and **Shielded** (silent payments, BIP 352, `sp1…`).
It also handles BRC-20 / BRC2.0, Ordinals, LEAF (CRC-20), RGB tokens and Cashu ecash, and gives websites `window.masked`, a UniSat-compatible provider.

## Commands

```sh
npm ci
npm run check   # lint + typecheck + every test. Must pass before any commit.
npm run build   # rebuilds extension/ from src/
```

Node 20+. Plain JavaScript ES modules, no framework, types checked from JSDoc (`tsc`). Bundled with esbuild.

## Where things are

- `src/` is the source of truth. `extension/`, `dist/` and `android/…/public` are build output: never edit them by hand.
- Layout and rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Short version:
  - `src/core`, `src/crypto`, `src/bitcoin`, `src/ordinals`, `src/trade/trade-core.mjs`: pure (no state, no network), tested in Node.
  - Services are classes built once in `src/app/MaskedApp.mjs` and reached as `this.app.<name>`.
  - Screens: `src/ui/views/*View.mjs` render HTML strings; `src/ui/Controller.mjs` handles every click. Views never change state.
  - dApp provider: `src/provider/` (inpage, content bridge, background). Approvals: `src/dapp/`.
  - RGB: `src/rgb/` (WebAssembly engine built from `engine/`).
- Tests: `test/*.mjs`, run on the real classes (`test/helpers/wallet-app.mjs`). Add a test with every behaviour change.
- Provider API reference: [docs/PROVIDER.md](docs/PROVIDER.md). Keep it in sync when you change `window.masked`.

## Hard rules

These protect people's money. Don't break them, even if a task seems to ask for it.

1. **Keys never leave the wallet page.** Never log, send, store unencrypted or expose a recovery phrase, private key, scan key or salt. The background script and websites never handle keys.
2. **No remote code.** No `eval`, no scripts loaded from a server, no new CDN. Crypto comes only from `@noble/*` / `@scure/*`.
3. **No new runtime dependencies** without the maintainer agreeing first.
4. **Storage keys never change.** Existing wallets read `wren.*` keys and per-wallet ids (`net:Bscan:Bspend`). Renaming one loses people's data.
5. **Every signature or payment a site asks for goes through an approval** the person sees and confirms. Never add a silent path.
6. **No `alert()`, `confirm()` or `prompt()`.** Use the in-wallet UI.
7. Anything that builds, signs or broadcasts a transaction needs a test, and manual testing on **Signet**, never Mainnet.
8. Never commit secrets, `.env` files or keystores.

## Text in the UI

- Plain, short English from the user's side ("Send", "Shield", "Protected"), no jargon where a plain word works.
- Every new UI string needs a Chinese line in `src/i18n/zh-CN.mjs`, then run `node scripts/i18n-export.mjs` (the i18n test checks it).
- Don't promise prices, returns, airdrops or rewards, and don't imply partnerships.

## Before you finish

- `npm run check` passes.
- New behaviour has a test; docs updated (`docs/`, `CHANGELOG.md` for user-visible changes).
- Version bumps touch `package.json`, `src/manifest.json` and `CHANGELOG.md` together; the maintainer does releases.
