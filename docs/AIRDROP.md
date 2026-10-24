# Silent airdrop

Send → **Airdrop** pays the same amount to many Shielded addresses in one transaction. Every recipient gets an ordinary silent payment (BIP 352). On-chain, nobody can tell who was paid, or that the outputs were one airdrop.

## Using it

1. Send → **Airdrop**.
2. Choose **Pay from**: Public or Shielded.
3. **Who gets it:** paste addresses, one per line, or copy a whole X reply thread. MASKED finds every `sp1…` address (`tsp1…` on Signet). It removes duplicates and skips:
   - addresses from the other network;
   - your own address;
   - anything that isn't a valid address.
4. **Each person gets:** an amount in sats (at least 330).
5. Review (people, total, network fee) → **Send to N people**. Then **Tell them on X** opens a ready post.

Up to 500 people per airdrop. For more, split the list.

## How it is built

- **Coin selection:** biggest coins first, until the total, the fee and a change output are covered. Change returns to the side that paid: to the Public address, or to the wallet's Shielded change address (label 0).
- **Silent outputs:** every input key takes part in the BIP 352 derivation. Recipients that share a scan key get consecutive `k` values.
- **Fee:** `(10.5 + 57.5·inputs + 43·outputs) × rate`.

## Code and tests

- `src/wallet/Airdrop.mjs`: `extractRecipients`, `Airdrop.build`, `dropFee`.
- `src/ui/views/AirdropView.mjs`: the Airdrop tab of Send (form, review, done).
- `test/airdrop.test.mjs` covers:
  - extracting addresses from a messy thread;
  - a 40-person Mainnet airdrop from Public, where each recipient's own scan finds exactly one 1,000-sat coin it can spend;
  - an airdrop from Shielded, where the change comes back Shielded and is found;
  - Signet addresses;
  - the errors: nothing found, too little each, more than 500 people, not enough balance.
