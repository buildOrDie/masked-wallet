# LEAF (CRC-20) in MASKED (2.18)

[LEAF](https://crc20.org) is a CRC-20 token on Bitcoin mainnet. Its balances belong to addresses, not to coins, and a transfer is an ordinary Bitcoin transaction with one fixed layout. MASKED reads balances from crc20.org's public read-only API (no key, no node) and builds transfers itself.

## Where it shows

- **Home → LEAF** on the Public side (always on Mainnet), and on the Shielded side once you hold some there.
- The LEAF page shows both balances, confirmed by crc20.org, and sends from either side.

## Sending

MASKED builds every transfer the way the CRC-20 rules require, because a transaction that breaks a rule still confirms on Bitcoin but moves no LEAF:

| Position | Content |
|---|---|
| `vin[0]` | a coin of the sending address (taproot key path, `SIGHASH_DEFAULT`) |
| `vin[1…]` | more coins for the fee, from the same side |
| `vout[0]` | one OP_RETURN: `{"p":"crc-20","op":"transfer","tick":"LEAF","amt":"<atoms>"}` |
| `vout[1]` | the receiver: 330 sats (bc1p) or 294 sats (bc1q) |
| `vout[2…]` | BTC change |

- Receivers: `bc1p…`, single-key `bc1q…`, or a Shielded `sp1…`. `1…`, `3…`, P2WSH and multisig are refused: LEAF sent there can never move again.
- Amounts are exact (8 decimals, BigInt), never floats.
- A send stays subtracted from your balance until crc20.org's indexer has reconciled it, so you can't spend the same LEAF twice while it confirms. The reservation is saved on your device, so it survives closing the wallet or restarting the browser, and a lagging indexer (`503`, or `synced: false`) keeps it in place. It is released when:
  - crc20.org lists the transaction: the LEAF moved;
  - the indexer is synced past the block that confirmed it and still lists no LEAF operation for it: it broke a rule and no LEAF moved (the LEAF page says so);
  - Bitcoin no longer knows the transaction an hour after it was sent (dropped or replaced).
- Unconfirmed LEAF transfers from or to your addresses (found in the mempool) show as "sending" or "incoming" until a block.

## Private LEAF (Shielded)

Send LEAF to a Shielded `sp1…` address and MASKED puts a silent payment at `vout[1]`: the receiver gets the LEAF on a fresh one-time address that nobody can link to them.

Each Shielded payment is its own address, so Shielded LEAF is held per address:

- `vin[0]` is the coin of the address that holds the LEAF; the fee comes from your Shielded balance, and change stays Shielded.
- One transfer moves LEAF from one address (the rules allow one OP_RETURN per transaction). The LEAF page says how much one send can move.
- Sending part of an address's LEAF also returns 330 sats to that same address, so the rest stays spendable.
- If an address holding LEAF has no coin left, the LEAF is safe; sending a little BTC to it makes it spendable again.

## Privacy of balance lookups

Asking crc20.org about an address tells crc20.org that someone is interested in it. Asking about several Shielded one-time addresses from the same connection, at the same time, would let it guess they belong together. So MASKED asks only about:

- your **Public** address;
- **Shielded addresses it knows hold LEAF**: ones you sent LEAF to from this wallet.

To find LEAF that someone else sent to your `sp1…` address, turn on **Find LEAF sent to my Shielded address** on the LEAF page. MASKED then also asks about your small Shielded coins (LEAF arrives on 330-sat outputs; bigger BTC coins are never looked up). Turn it off again when you are done.

## Not supported yet

AXBT, the AXBT/LEAF pool, marketplace sales and soft covenants.
