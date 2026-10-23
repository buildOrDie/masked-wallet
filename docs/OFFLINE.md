# Offline send

Sign a Bitcoin payment with no internet. Hand it over as a QR code or as text (in any chat: Bitchat works without internet). The first device that gets online sends it to the network, whether that's yours or the receiver's.

## Sending

1. Send → fill in the form → Review.
2. Tap **Sign now, send later**. When the device is offline, this is the main button.
3. MASKED shows the signed payment:
   - a QR code (the raw transaction, upper-case hex, so it fits in a smaller code);
   - **Copy signed payment**, a short line of context plus the raw transaction.

The fee uses the last rates the wallet saw. The coin it spends is **held back**, so no other send, shield or mint from this wallet picks it again. When the device is online, MASKED sends it by itself. It tries when the browser reports a connection, after each sync, and every 20 seconds while the wallet is open.

Paying an sp1 address needs nothing from the network: the wallet computes the one-time output from its own key and the address. So a fully offline payment still lands silent.

## Receiving a signed payment

Receive → **Got a signed payment?** Paste the text, or what the phone camera read from the QR. MASKED checks that it is one well-formed transaction and keeps it. As soon as the device is online, it broadcasts it and reads it back, so a Shielded payment to you appears in your balance.

Anyone can also broadcast the raw transaction somewhere else, for example mempool.space/tx/push.

## What it is and is not

A signed payment is a **promise until it confirms**. The sender could still spend the same coins in another transaction first. Use it with people you trust, or wait for the confirmation.

What can happen when a waiting payment is sent:
- **The network already has it** (the other side sent it first): MASKED marks it sent.
- **Its coins were spent elsewhere:** MASKED marks it failed and releases the coin.

## Code

- `src/bitcoin/parseTx.mjs`: strict raw-transaction reader, and `findTxHex` to pull the transaction out of pasted text.
- `src/wallet/OfflinePayments.mjs`: the list of signed payments per wallet, reserved coins, sending when online.
- `src/ui/views/SendView.mjs` (the signed-payment screen) and `src/ui/views/RelayView.mjs` (paste and list).
- `test/offline.test.mjs` covers four cases on the real wallet services:
  - one wallet signs offline, another relays it, and the receiver's Shielded scan finds the coin;
  - the network already has it;
  - the coins were spent elsewhere;
  - bad input is refused.
