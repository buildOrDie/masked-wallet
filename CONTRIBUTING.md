# Contributing to MASKED

Thanks for helping! A few ground rules keep a wallet codebase safe.

## Setup

```sh
npm ci
npm test         # must stay: pass 2468 fail 0
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

- `src/sp-core.mjs`: pure BIP 352 logic, covered by the official vectors. Keep it dependency-light and side-effect free.
- `src/app.mjs`: the wallet UI and transaction building.
- `src/provider/*`: the dApp provider (page, bridge, background). The background must never handle keys.

## Reporting bugs

Open an issue with the version, browser, network and steps to reproduce. Security issues: see [SECURITY.md](SECURITY.md).
