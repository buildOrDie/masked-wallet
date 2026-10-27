# Pay an @handle (2.17)

A normal Bitcoin address should never be posted publicly: everyone can then see every payment it receives. A **Shielded address** (silent payments, BIP 352) can be: each payment lands on a new one-time output that nobody can link to it. MASKED uses that to let you pay people by their X handle.

## Send to @someone

In **Send**, type `@someone` in **To**, enter an amount and tap **Review**. MASKED:

1. asks the MASKED directory which post belongs to `@someone` (the directory only answers with a post link);
2. reads that post on X itself, through X's public embed endpoint (`publish.twitter.com/oembed`);
3. checks that the post was written by `@someone`, mentions `@masked_wallet` and holds exactly one Mainnet Shielded address;
4. shows the post next to the payment, then builds a normal silent payment to that address.

If the directory pointed `@someone` at somebody else's post, step 3 fails and nothing is paid. The first time, Chrome asks to let MASKED read posts on X (`publish.twitter.com`).

After sending, **Tell @someone on X** opens a post that mentions them. It never includes the amount.

## Claim your @

**Receive → Shielded → Get paid with your @handle**:

1. **Post on X**: MASKED writes the post with your Shielded address and `@masked_wallet`. Keep both in it.
2. **Paste the link** to your post and tap **Check & claim**. MASKED checks the post holds this wallet's Shielded address, then registers it.

Anyone with MASKED can then pay you by typing your @. Your pay page is `maskedwallet.com/pay/<handle>`.

- **Change address:** post again and claim the new post. A newer post replaces an older one; an older post can't be replayed.
- **Stop:** delete the post. MASKED checks the post before every payment, so a deleted post can't be paid.
- **Renamed your X account?** Claim again under the new handle; the old handle stops working.

## What it shows, and what it doesn't

- Your post links your X account to your Shielded address. That's public, as with any address you post.
- Payments to it stay private: on-chain, nobody can find them by looking at the address, or tell how many you got or how much.
- Mainnet only. Each account has its own Shielded address, so each account can claim its own handle.
