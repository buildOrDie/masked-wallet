# Translating MASKED

MASKED is written in English. Other languages are swapped in when a screen is shown: each sentence is looked up by
its English text in a dictionary. A sentence that isn't in the dictionary stays in English, so a missing line never
breaks anything. People pick the language in **Settings → Language · 语言**. English is the default.

## 简体中文 (Simplified Chinese) — beta

The Chinese text is a **draft** and needs review by native speakers. It covers setup and unlocking, Home, Send,
Shield, Receive, the coin list, accounts and Settings. Ordinals, ecash, BRC-20, Mint and RGB are still English.

### How to review

1. Open [`zh-CN.csv`](zh-CN.csv) (any spreadsheet app works).
2. For each row, read the English and the 中文. Fix the 中文 if it is wrong, unclear or sounds unnatural.
3. Set `reviewed` to `yes` for rows you checked. Use `note` for questions.
4. Send the file back in a pull request or an issue.

Please take extra care with the rows about the **recovery phrase (助记词)**, **passwords**, **sending** and
**look-alike addresses**: a wrong word there can cost someone money.

### Rules

- Keep `{0}`, `{1}`… exactly: they become amounts, names or addresses.
- Keep inline tags like `<b>…</b>` around the same words.
- Keep brand and technical names: MASKED, Bitcoin units (BTC, sat/vB), Taproot, RBF, BRC-20, Cashu, UniSat, Xverse.
- Terms used throughout: 钱包 wallet · 公开 Public · 隐私 Shielded · 助记词 recovery phrase · 密码 password ·
  矿工费 network fee · 铭文 inscription · UTXO coin · 静默支付 silent payments · 主网 Mainnet · 铸造 Mint.
  If a better term fits, change it everywhere in one go.

### For developers

- Dictionary: `src/i18n/zh-CN.mjs`. Translator: `src/i18n/translate.mjs`.
- `node scripts/i18n-collect.mjs` lists English lines on the main screens that have no translation yet.
- `node scripts/i18n-export.mjs` writes the review file; `node scripts/i18n-import.mjs` reads a reviewed file back.
- Text in elements with class `mono` or `translate="no"` (addresses, keys, amounts) is never translated.
- The Chrome Web Store name and description are in `extension-template/_locales/<locale>/messages.json`.
