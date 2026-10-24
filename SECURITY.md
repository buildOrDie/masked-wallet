# Security

MASKED is **experimental, unaudited software**. Treat it as a hot wallet for testing and small amounts.

## Known limitations (read before using real funds)

- **Password strength matters:** the vault is only as strong as your password. Use a long, unique one.
- **While unlocked**, the phrase is held in memory and in `chrome.storage.session` (RAM only, never written to disk, cleared when the browser closes). Malware running in your browser or OS can still read it.
- **Hot wallet:** keys are used inside the browser. There is no hardware wallet support yet.
- **Third-party data:** balances, fees and broadcasts go through public Bitcoin APIs (mempool.space, blockstream.info) or a server you set. They can see your IP and the Public address you query. Token balances go through the MASKED token server (tokens.maskedwallet.com), which sees your Public address. Inscription checks go to ordinals.com.
- **Shielded scanning** downloads public block data from the MASKED scan server (or public APIs). It never receives your scan key, and it can't tell which outputs are yours, but it sees which block ranges your wallet asks for.
- **BRC2.0 balances** shown in the wallet are worked out from the inscriptions it holds. An indexer (e.g. Best in Slot / OPI) has the final word.
- **Offline send:** a signed payment is a promise until it confirms. Whoever signed it can still spend the same coins elsewhere first. MASKED holds the coin back in the wallet that signed it, but not in another wallet restored from the same phrase. The signed text is the whole transaction, so anyone who sees it can broadcast it. That's fine, since it can only pay the recipients it was signed for.
- **Silent airdrop:** recipients can't be linked to their addresses, but the transaction clearly looks like a batch payout (many outputs of the same size), and every recipient can see that transaction.
- **Share on X** opens x.com with your Shielded address in a post. Posting it links that address to your X account. It does not link the payments you receive.

## What protects you today

- **Encrypted at rest:** the recovery phrase is stored only as an AES-256-GCM vault, keyed by PBKDF2-SHA256 (600,000 iterations, random 16-byte salt) from your password. Nothing else on disk can spend funds. Older plaintext wallets are migrated and the plaintext copy is deleted.
- **Auto-lock** after 5 min to 4 h of inactivity (default 15 min), plus a lock button. Locking reloads the page so no key stays in memory.
- Showing the recovery phrase and changing the password both require the password.

- The dApp provider holds no keys. Every signature, payment or inscription opens an approval in the MASKED popup that shows the requesting site.
- Sites only see the Public address. Shielded coins are never exposed.
- Coins holding inscriptions are excluded from automatic coin selection, and PSBTs that spend them need an extra explicit confirmation.

## Reporting a vulnerability

Please **do not open a public issue**. Email maskedbtc@gmail.com or use GitHub's *Report a vulnerability* (private advisory) on this repository. Include steps to reproduce and the affected version (`extension/manifest.json` → `version`).

We aim to acknowledge reports within 72 hours.
