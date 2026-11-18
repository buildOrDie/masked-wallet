# FAQ

**Is MASKED free?**
Yes. MASKED is free and open source under the MIT licence. You only pay normal Bitcoin network fees (and a mint's fees for ecash, if it charges any).

**Who holds my keys?**
You do. The recovery phrase is stored only encrypted on your device (AES-256-GCM, 600,000 PBKDF2 iterations). Websites and MASKED's servers never see it.

**Is it audited?**
No. MASKED is experimental and unaudited. Use small amounts. Details: [SECURITY.md](https://github.com/buildOrDie/masked-wallet/blob/main/SECURITY.md).

**Public or Shielded: which should I use?**
Public for exchanges, marketplaces and websites that need a normal address. Shielded (`sp1…`) for receiving privately: every payment lands at a new place on chain, so nobody can link your payments or see your balance from the address.

**Can someone see my Shielded balance from my `sp1…` address?**
No. The address can't be looked up on a block explorer. Only your wallet can find the payments made to it.

**Can I pay an `sp1…` address from another wallet?**
Only from wallets that support silent payments (BIP 352). From MASKED, you can pay one from either side.

**I forgot my password.**
Restore with your recovery phrase (link on the unlock screen) and set a new password. Without the phrase, the wallet can't be recovered.

**I restored my wallet and the Shielded balance is missing.**
The Shielded side has to scan the chain to find its payments. Give it time, and check the date you gave for when you first used the wallet. **Settings → Rescan history** scans again.

**Why are some coins "protected"?**
Coins holding inscriptions, and very small coins, are kept out of normal sends so you don't spend an NFT by accident. Tap the protected line on Home to see or unlock them.

**What is Signet?**
Bitcoin's test network. Its coins have no value, so it's where you try features for free. Switch in Settings → Network.

**Do I need a backup for RGB tokens?**
Yes. Your recovery phrase alone can't bring RGB tokens back. MASKED keeps an encrypted cloud backup after each change (locked with keys from your phrase, so the server can't read it), and you can save backup files in Settings → RGB. RGB on Mainnet is a beta.

**Is ecash safe?**
Ecash is held by the mint you choose: it's custodial. It's great for instant small payments; keep amounts small.

**Is the RGB market custodial?**
Instant listings and peer-to-peer swaps are signed by your wallet. Launchpad sales go through an escrow, which is custodial while a sale is open.

**Does MASKED work with sites made for UniSat?**
Mostly, yes. `window.masked` follows the `window.unisat` API: see [PROVIDER.md](PROVIDER.md).

**Where can I ask questions?**
In the MASKED chat on Telegram: [t.me/maskedwallet](https://t.me/maskedwallet). Admins never DM you first, and nobody there needs your recovery phrase.

**Where do I report a bug?**
[Open an issue](https://github.com/buildOrDie/masked-wallet/issues/new/choose). Security problems go privately: [SECURITY.md](https://github.com/buildOrDie/masked-wallet/blob/main/SECURITY.md).

**Where are the updates posted?**
On the developer's X: [@ratsonchain](https://x.com/ratsonchain), and in [CHANGELOG.md](https://github.com/buildOrDie/masked-wallet/blob/main/CHANGELOG.md).

**Is there a MASKED support account that DMs people?**
No. Support happens in the open, in the [Telegram chat](https://t.me/maskedwallet) and on GitHub. Nobody from MASKED will DM you first or ask for your recovery phrase. Anyone who does is a scammer.
