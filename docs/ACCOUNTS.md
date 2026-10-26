# Accounts

One recovery phrase gives several accounts. Tap the account name in the header to switch, add (+), rename or hide.

## Keys

| | Account 1 | Account N+1 |
|---|---|---|
| Public (BIP 86) | `m/86'/coin'/0'/0/0` | `m/86'/coin'/0'/0/N` |
| Shielded scan (BIP 352) | `m/352'/coin'/0'/1'/0` | `m/352'/coin'/N'/1'/0` |
| Shielded spend (BIP 352) | `m/352'/coin'/0'/0'/0` | `m/352'/coin'/N'/0'/0` |

`coin` is 0 on Mainnet and 1 on Signet.

- **Account 1 is the wallet of every earlier version**: same keys, same addresses, same saved data.
- **Public addresses follow UniSat's accounts**: UniSat's account N is the N-th address on `m/86'/0'/0'/0/…`, so restoring a UniSat phrase (with the same BIP 39 passphrase, if any) and adding accounts shows the same Public addresses in the same order, on Mainnet. Tested against the BIP 86 test vectors.
- **Shielded uses one BIP 352 account each**, so every account has its own `sp1…` address.

## What is per account

Coins, locks, tokens and their history, pending transfers, signed offline payments, private trading state and the history scan are all filed per account. Connected websites see the open account's Public address and get `accountsChanged` when you switch.

## Names and the list

Names, hidden accounts and the open account are labels kept on this device (`wren.accounts.<master fingerprint>`), never in the vault and never sent anywhere. The keys always come from the phrase. On a new device the list starts with Account 1 again: add accounts to bring them back.

## History scan

An account added here is new, so its Shielded history scan starts when it was added. Its Public balance is always looked up by address, so coins received before (for example in UniSat) show at once. If an added account did receive Shielded payments earlier (a phrase restored on a new device), use Settings → Rescan history on that account.

Wallets made from raw keys, and the demo, have one account.
