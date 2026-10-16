# `window.masked` provider API

MASKED injects `window.masked` into every `http(s)` page. The API follows UniSat's (`window.unisat`), so most dApps only need to change the object they call.

```js
const wallet = window.masked;            // undefined if MASKED is not installed
window.addEventListener('masked#initialized', () => { /* fired once injected */ });
```

All methods return Promises. Errors are `Error` objects with a numeric `code`:

| Code | Meaning |
| --- | --- |
| `4001` | The user rejected the request (or closed the approval window). |
| `4100` | The site is not connected, or no wallet has been set up. Call `requestAccounts()` first. |
| `4200` | Method not supported. |
| `4900` | The page lost its connection to the extension. Retry. |
| `4000` | Any other error (invalid params, network error, …). The message explains it. |

Methods marked 🔐 open an approval window.

## Accounts

### `requestAccounts(): Promise<string[]>` 🔐 (first time)
Asks the user to connect this site. Returns `[publicAddress]`. Already-connected sites get the answer immediately.

### `getAccounts(): Promise<string[]>`
`[publicAddress]` if connected, otherwise `[]`.

### `getPublicKey(): Promise<string>`
The account's 33-byte compressed public key (hex). This is the taproot *internal* key; the address is its BIP 86 tweak.

### `getBalance(): Promise<{ confirmed: number, unconfirmed: number, total: number }>`
Balance of the Public address, in sats.

### `getShieldedAddress(): Promise<string>` *(MASKED only)*
The wallet's silent payment address (`sp1…` / `tsp1…`). Payments to it are private, and the dApp cannot see them arrive.

### `disconnect(): Promise<true>`
Removes this site's connection. Users can also disconnect sites under **Settings → Connected sites**.

## Network

### `getNetwork(): Promise<'livenet' | 'testnet'>`
UniSat-style network name: `'livenet'` on Mainnet, `'testnet'` on Signet (UniSat's name for test networks). Use `getChain()` to be exact.

### `getChain(): Promise<{ enum, name, network }>`
`enum` is `BITCOIN_MAINNET` or `BITCOIN_SIGNET`. MASKED supports Mainnet and Signet only.

### `switchNetwork(network): Promise<string>` 🔐
`'livenet' | 'signet'` (`'testnet'` also opens Signet).

### `switchChain(chainEnum): Promise<{ enum, name, network }>` 🔐

## Signing

### `signMessage(message, type = 'ecdsa'): Promise<string>` 🔐
- `'ecdsa'`: Bitcoin Signed Message, a 65-byte compact recoverable signature (base64) by `getPublicKey()`.
- `'bip322-simple'`: a BIP-322 simple signature (base64 witness) for the Public P2TR address.

### `signPsbt(psbtHex, options?): Promise<string>` 🔐
Signs the inputs that belong to the Public address and returns the PSBT hex.

```ts
options = {
  autoFinalized?: boolean,                 // default true
  toSignInputs?: { index: number, address?: string, publicKey?: string, sighashTypes?: number[] }[],
}
```

- Without `toSignInputs`, every input paying to the Public address is signed.
- `sighashTypes` (or the PSBT's own `sighashType`) are respected, e.g. `0x83` (SINGLE|ANYONECANPAY) for marketplace listings.
- Taproot key-path only. `disableTweakSigner` (script-path) is not supported yet.
- **Inscription safety:** if an input to sign holds an inscription, the approval window shows a red warning, and the user must tick a box before signing.

### `signPsbts(psbtHexs, options?): Promise<string[]>` 🔐
Same as `signPsbt`, for several PSBTs in a single approval. `options` is an array that matches `psbtHexs`.

## Sending

### `sendBitcoin(toAddress, satoshis, { feeRate? }): Promise<string>` 🔐
Pays from the Public balance and returns the txid. `toAddress` can be any address on the current network, **including a silent payment address**: the wallet derives the one-time output for you.

### `pushPsbt(psbtHex): Promise<string>`
Finalizes (if needed), extracts and broadcasts a signed PSBT. Returns the txid.

### `pushTx(rawTxHex): Promise<string>`
Broadcasts a raw transaction. Returns the txid.

## Inscriptions and BRC-20

### `getInscriptions(cursor = 0, size = 20): Promise<{ total, list }>`
Inscriptions on the Public address (read from ordinals.com). Each item: `{ inscriptionId, inscriptionNumber, address, outputValue, contentType, content, preview, output, offset, timestamp }`.

### `inscribeTransfer(ticker, amount, options?): Promise<{ inscriptionId, txid, commitTxid, ticker, amount }>` 🔐
Inscribes a BRC-20 / BRC2.0 **transfer** of `amount` on the Public address (two transactions: commit and reveal), ready to list or send. The new coin is reveal output 0 (330 sats) and can be used before it confirms.

`options.account` *(MASKED only, private trading, see below)*: `'trade'` inscribes on the private trade address; `'shielded'` inscribes on the Shielded coin that holds the tokens and also returns `{ address, outpoint, value }`: list it from that `address`.

## Private trading *(MASKED only)*

Sites can trade from the user's Shielded balance without ever seeing the Public or Shielded address. Available on **maskedwallet.com** for now; other origins get `4200`.

- **Trade address:** a plain `bc1p…` made from the spend key (`src/trade-core.mjs`), not linked to the Public or Shielded address.
- **Shielded listings (2.12.5+):** tokens are listed straight from the Shielded coin that holds them, from that coin's one-time address.

### `getTradeAccount(): Promise<TradeAccount>` 🔐 (first time per site)

```ts
TradeAccount = {
  address: string,            // the trade address
  publicKey: string,          // its x-only key (hex)
  index: number,
  features: string[],         // e.g. ['shieldedListing']
  shielded: {
    sats: number,                                   // spendable Shielded bitcoin
    tokens: { ticker: string, amount: string }[],   // free Shielded token balances
    transfers: { ticker, amount, inscriptionId, outpoint, value, address, pending }[], // inscribed to sell
  },
}
```

### `fundTradeAccount(satoshis, { padding?, feeRate? }): Promise<{ txid, address, outputs }>` 🔐
Moves bitcoin from Shielded to the trade address (change goes back to Shielded). `padding: true` also makes the small 600-sat coin a purchase lands in. The new outputs can be spent at once.

### `moveToTradeAccount(ticker, amount): Promise<{ txid, inscriptionId }>` 🔐
Moves tokens from Shielded to the trade address (three transactions).

### `returnToShielded(ticker?, amount?): Promise<{ txid, address, renewed }>` 🔐
Without arguments: moves all bitcoin and items on the trade address back into Shielded as silent payments (each inscription keeps its own coin). Once the address is empty, the next trades use a fresh one (`renewed`). With a ticker: moves those tokens back.

### `cancelShieldedListing(outpoint): Promise<{ txid }>` 🔐
Cancels a listing made straight from Shielded by moving its coin back into Shielded, so the signed listing stops working everywhere.

`signPsbt` also signs inputs of the trade address and of Shielded listings (maskedwallet.com only).

## Events

```js
window.masked.on('accountsChanged', (accounts) => {});   // [] when disconnected
window.masked.on('networkChanged', (network) => {});     // 'livenet' | 'testnet'
window.masked.on('chainChanged', (chain) => {});          // { enum, name, network }
window.masked.on('tradeAccountChanged', (trade) => {});  // MASKED only: TradeAccount, after a move or a renewed address
window.masked.removeListener('accountsChanged', fn);
```

## Supporting both UniSat and MASKED

```js
const provider = window.masked ?? window.unisat;
```

## Privacy model

- Sites see the **Public** address, its public key and its balance. With private trading allowed, maskedwallet.com also sees the trade address and the Shielded totals, never the Shielded address or its payments.
- Shielded coins are invisible to dApps. `getShieldedAddress()` only shares the reusable receive address.
- Provider calls never go to MASKED servers. `getBalance` reads mempool.space and `getInscriptions` reads ordinals.com, straight from the extension.
