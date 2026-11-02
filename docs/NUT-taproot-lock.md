# NUT draft: Lock ecash to a Taproot address

`optional` · `depends on: NUT-10, NUT-11` · status: **draft**, implemented in MASKED 2.19

---

This document describes how a wallet locks ecash to a Bitcoin Taproot address (`bc1p…`), and how the owner of that
address claims it. **Mints need no change.** The lock is an ordinary [NUT-11][11] P2PK lock whose public key comes from
the address.

## Motivation

A Cashu token is a bearer instrument: whoever sees it can claim it. Tokens are shared in chats, emails and logs, so a
token sent to the wrong place is lost. NUT-11 solves this by locking a token to a public key, but people don't share
raw public keys. They share Bitcoin addresses.

A Taproot address already *is* a public key. Its witness program is the 32-byte x-only output key `Q` ([BIP-341][341]),
and NUT-11 signatures are already [BIP-340][340] Schnorr signatures, which use only the x coordinate. So a payer can
lock ecash to the address the payee already publishes, and the payee claims it with the key their Bitcoin wallet
already holds.

## Deriving the lock key

Given a Taproot address:

1. Decode it with bech32m ([BIP-350][350]). The witness version MUST be `1` and the program MUST be 32 bytes. Wallets
   MUST refuse any other address type (`1…`, `3…`, `bc1q…`) for this lock.
2. The lock key is `02 || program`: the 33-byte compressed public key with even y whose x coordinate is the program.

```
P2PK "data" = "02" || hex(witness_program)
```

The `02` prefix matches how BIP-340 lifts an x-only key, which is what verification uses. Mints that verify NUT-11
signatures with BIP-340 on the x coordinate accept it unchanged.

## Locking

The payer builds outputs exactly as in NUT-11, with `data` set to the derived lock key:

```json
["P2PK", { "nonce": "<random>", "data": "02<x(Q)>", "tags": [["locktime", "<unix>"], ["refund", "<payer key>"]] }]
```

Wallets SHOULD add a `locktime` and a `refund` key of their own (NUT-11), so a token the payee never claims comes back
to the payer. MASKED uses 7 days. Before the locktime only the payee can claim; after it, either key can.

## Claiming

The address owner signs `SHA256(secret)` with BIP-340, using the private key of the **output key** `Q`, which is the same
key a Taproot key-path spend uses:

- For a [BIP-86][86] (key-path only) address with internal private key `d` and internal key `P = d·G`:
  - if `P` has odd y, replace `d` with `n − d`
  - `t = int(hash_TapTweak(x(P)))`, then `d' = d + t mod n`
  - if `Q = d'·G` has odd y, replace `d'` with `n − d'`
- Sign `SHA256(secret)` with `d'` (BIP-340) and put the signature in the proof's NUT-11 witness, as usual.

Wallets that already sign Taproot key-path spends hold `d'` (or can compute it) and need no new key material.

## Wallet behaviour

- Accept a `bc1p…` address anywhere a NUT-11 lock key is accepted ("Lock to an address").
- When receiving a token, compare each expected witness key (`getP2PKExpectedWitnessPubkeys`) by **x coordinate**
  against the wallet's Taproot output keys, and sign with the matching `d'`.
- Show the payer which address a token is locked to, and when the refund becomes possible.
- In [NUT-18][18] payment requests, a payee asks for this lock with `nut10: { k: "P2PK", d: "02<x(Q)>" }`. No new field
  is needed.

## Security and privacy

- **Domain separation.** The signed message is `SHA256` of a NUT-10 JSON secret. A Taproot sighash is a BIP-340 *tagged*
  hash (`TapSighash`), so a claim signature can't be replayed as a Bitcoin transaction signature, or the other way round.
- **Script-path addresses.** If `Q` commits to a script tree, its owner can still compute `d'` when they hold the internal
  key. If the internal key is a NUMS point (script-only), nobody can sign and a token locked to it can never be claimed
  without the refund path. An address alone can't show this, which is one more reason to always include a refund.
  Multi-party keys (MuSig2, FROST) can claim through their own signing protocols.
- **Linkability.** At claim time the mint sees the lock key, so it learns that this on-chain address receives ecash.
  Payees who care should share a fresh address for ecash. A blinded-key P2PK variant, where supported, would hide the key
  from the mint.
- **Address reuse.** Locking ecash doesn't put anything on-chain and doesn't spend from the address.

## Test vectors

Using the BIP-86 test phrase `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon
about`, path `m/86'/0'/0'/0/0`:

| | |
| --- | --- |
| Address | `bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr` |
| Internal key `x(P)` | `cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115` |
| Output key `x(Q)` | `a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c` |
| **Lock key** | `02a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c` |
| Output private key `d'` | `1553fe90c9173e7cb804530fa5486997b1b2dffee10cae5f8d31c0bc6bd89109` |

Secret:

```
["P2PK",{"nonce":"859d4935c4907062a6297cf4e663e2835d90d97ecdd510745d32f6816323a41f","data":"02a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c","tags":[["locktime","1893456000"],["refund","0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]]}]
```

| | |
| --- | --- |
| `SHA256(secret)` | `4e05f4ac7cb6d0674bd10ee143416582e48ee4839380ce8221f498a1bdda93ac` |
| BIP-340 signature with `d'`, aux = 32 zero bytes | `c5ae78fc9288c8c72c0e0f41d8386437b0be0aafc5792cafa670c213b57487a65410986655679aafde7bcbc75ed2f36ad17245017b3aac2863f2e7591a23894d` |

The signature verifies against `x(Q)`. The private key above is from a public test phrase: never use it for funds.

## Reference implementation

MASKED ([`src/ecash/EcashBook.mjs`](../src/ecash/EcashBook.mjs): `lockKeyOf`, `send`, `receive`, `canReclaim`) and its
tests ([`test/ecash.test.mjs`](../test/ecash.test.mjs)), run end to end against an unmodified nutshell mint.

[10]: https://github.com/cashubtc/nuts/blob/main/10.md
[11]: https://github.com/cashubtc/nuts/blob/main/11.md
[18]: https://github.com/cashubtc/nuts/blob/main/18.md
[86]: https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki
[340]: https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
[341]: https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki
[350]: https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
