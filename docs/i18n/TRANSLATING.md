# Translating MASKED

MASKED is written in English. Other languages are swapped in when a screen is shown: each sentence is looked up by
its English text in a dictionary. A sentence that isn't in the dictionary stays in English, so a missing line never
breaks anything. People pick the language in **Settings → Language · 语言**. English is the default.

## 帮忙校对中文翻译（不需要会编程）

MASKED 的中文翻译是初稿，需要母语者校对。你可以用以下任一方式帮忙：

**方式一：直接在 GitHub 网页上修改**
1. 打开 [`zh-CN.csv`](zh-CN.csv)。GitHub 会把它显示成表格，可以搜索。
2. 点右上角的 ✏️（编辑）。GitHub 会自动为你创建副本（fork）。
3. 修改「中文」那一列；改好的行把 `reviewed` 改成 `yes`，有疑问写在 `note`。
4. 点 **Commit changes… → Propose changes → Create pull request**。我们会审核后合并。

**方式二：提一个 Issue**
在 [Issues → New issue → Translation · 翻译](https://github.com/buildOrDie/masked-wallet/issues/new?template=translation.yml) 里填写英文原文、现在的中文和建议的中文。

**请特别注意**：助记词、密码、发送和相似地址相关的句子，翻错可能让人损失资产。
**规则**：保留 `{0}`、`{1}` 和 `<b>…</b>`；保留 MASKED、BTC、sat/vB、Taproot、RBF、BRC-20 等名称。
**安全**：切勿在 GitHub 上贴出助记词、密码、私钥或带余额的截图。

## 简体中文 (Simplified Chinese) — beta

The Chinese text is a **draft** and needs review by native speakers. It covers every screen: setup and unlocking,
Home, Send, Shield, Receive, coins, accounts, Settings, Mint and deploy, BRC-20 and BRC2.0, Ordinals, ecash, LEAF,
RGB, airdrops, signed payments, website approvals, and the error messages. A few technical errors stay in English.

### How to review

1. Open [`zh-CN.csv`](zh-CN.csv). GitHub shows it as a searchable table; the `screen` column groups the lines.
2. Tap ✏️ to edit it in the browser (GitHub makes a fork for you), or download it and use any spreadsheet app.
3. Fix the 中文 where it is wrong, unclear or sounds unnatural. Set `reviewed` to `yes` for rows you checked and
   use `note` for questions.
4. **Propose changes → Create pull request.** Or open an issue with the **Translation · 翻译** form.

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
- `node scripts/i18n-collect.mjs` renders the screens and lists English lines with no translation yet;
  `node scripts/i18n-scan.mjs` scans the code for messages and errors (it also catches some code fragments).
- `node scripts/i18n-export.mjs` writes the review file (keeping reviewers' marks and notes);
  `node scripts/i18n-import.mjs` reads a reviewed file back and refuses a row that drops a `{n}` or a `<b>` tag.
- To merge a reviewer's pull request: merge it, run the import, then `npm test` (the i18n test checks every row).
- Text in elements with class `mono` or `translate="no"` (addresses, keys, amounts) is never translated.
- The Chrome Web Store name and description are in `extension-template/_locales/<locale>/messages.json`.
