# Getting started

Five minutes from install to your first payment. MASKED is experimental: start with small amounts, or with free test coins on Signet.

## 1. Install

- **Chrome, Brave, Edge:** [Chrome Web Store](https://chromewebstore.google.com/detail/masked-wallet/pojmpfcbdmacabhckemelcbkmckhaoig). Pin it from the puzzle icon so it's one click away.
- **Android:** download the APK from [signet.maskedwallet.com/install](https://signet.maskedwallet.com/install). Android asks you once to allow the install, since it isn't on Google Play yet.

## 2. Create or restore a wallet

Open MASKED and pick **Create new** or **Restore**.

1. Choose a password (8 characters or more). It encrypts the wallet on this device only. It can't be recovered, but your recovery phrase can always restore the wallet.
2. **Write down your recovery phrase** on paper, in order, and keep it offline. Anyone with these words owns your coins. MASKED and its developer will never ask for them.
3. Tick that you wrote it down, and continue.

Restoring? Type your phrase, set a password, and tell MASKED roughly when you first used the wallet so it knows where to start looking for Shielded payments.

## 3. Your two balances

| | Use it for | Address looks like |
|---|---|---|
| **Public** | Exchanges, marketplaces, websites. Anyone can see it, like any Bitcoin address. | `bc1p…` |
| **Shielded** | Private bitcoin. Each payment lands somewhere new, so nobody can look up what you hold. | `sp1…` |

Tap either balance on Home to switch sides. Both come from the same recovery phrase.

## 4. Receive

Tap **Receive**, pick Public or Shielded, then copy the address or show the QR code. Your Shielded address can be shared publicly (a profile, a post): payers can't see your balance from it.

## 5. Send

Tap **Send**, paste an address (`bc1…`, `tb1…` or `sp1…`), enter the amount, check the review screen, and confirm.
MASKED warns you when an address looks like one you paid before but isn't (address poisoning), and when a send is a large share of your balance.

## 6. Shield

**Shield** moves bitcoin from Public to Shielded. After that, nobody can follow it from your Public address.

## Try it for free on Signet

Signet is Bitcoin's test network: coins have no value, so it's the place to try everything.
Switch in **Settings → Network → Signet**, get test coins from a Signet faucet, and try sends, RGB tokens and [the market](https://signet.maskedwallet.com/rgb).

## Keep it safe

- Back up the recovery phrase on paper. Never type it into a website, a chat or a form.
- **RGB tokens need their own backup**: the phrase alone can't bring them back. MASKED keeps an encrypted cloud backup (on by default); you can also save backup files in Settings → RGB.
- **Ecash is held by its mint** (custodial). Keep ecash amounts small.
- MASKED locks itself after 15 minutes by default (Settings → Auto-lock after). **Lock now** is in Settings.

## Next

- [FAQ](FAQ.md) · [all guides](README.md) · [safety](https://github.com/buildOrDie/masked-wallet/blob/main/SECURITY.md)
- News and updates: [@ratsonchain on X](https://x.com/ratsonchain)
