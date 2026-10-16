# Contributing to MASKED

Thanks for helping! A few ground rules keep a wallet codebase safe.

## Setup

```sh
npm ci
npm run check    # lint + type check + tests; must pass (BIP 352 vectors: pass 2468 fail 0)
npm run build    # rebuild extension/ (the installable extension)
```

Load the folder as an unpacked extension (see README) and use **Signet** for manual testing. `examples/demo.html` exercises every `window.masked` method.

## Pull requests

- Keep PRs focused. One feature or fix per PR.
- **Commit the rebuilt `extension/` folder** (`npm run build`) in the same PR, so the repo stays loadable and reproducible.
- Anything that builds, signs or broadcasts transactions needs a description of how you tested it (network, txids if on Signet/Testnet).
- No new runtime dependencies without discussion. Crypto must come from the audited `@noble/*` / `@scure/*` libraries.
- Never log or transmit private keys, phrases or salts. Never add remote code loading.

## Code layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- `src/crypto/`, `src/bitcoin/`, `src/ordinals/`, `src/core/` are pure (no state, no network). Keep them that way and test them in Node.
- Services are classes that take the app (`constructor(app)`) and reach other services as `this.app.<name>`. Add new ones in `src/app/MaskedApp.mjs`.
- A new screen is a class extending `View` (`src/ui/View.mjs`) with a `render()`; register it in `src/ui/Screen.mjs` and handle its buttons in `src/ui/Controller.mjs`.
- Never rename a storage key: existing wallets read them (`wren.*`, per-wallet ids `net:Bscan:Bspend`).
- `src/provider/*`: the dApp provider (page, bridge, background). The background must never handle keys.

## Reporting bugs

Open an issue with the version, browser, network and steps to reproduce. Security issues: see [SECURITY.md](SECURITY.md).
