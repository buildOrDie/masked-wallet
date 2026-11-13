// Peer-to-peer RGB swaps: tokens for BTC in one Bitcoin transaction, nobody in the middle.
//
//   inputs   0  the seller's RGB output (holds the tokens)      1  the buyer's bitcoin
//   outputs  0  OP_RETURN (the RGB commitment)                  1  the buyer's seal: SEAL_SATS, receives the tokens
//            2  the seller: price + its input's sats − SEAL_SATS 3  the buyer's change
//
// The steps, each approved in the wallet doing it (the market only passes the messages on):
//   buyer  prepareBuy  → session (its invoice, seal, bitcoin input, change script, fee)
//   seller prepareSale    → the PSBT with the RGB transfer, unsigned, and its consignment
//   buyer  signBuy     → checks the consignment and every output, then signs its input
//   seller completeSale   → signs its input, broadcasts, posts the consignment to the buyer's transfer server
// The transaction layout and the message fields are a plain, documented format (docs/PROVIDER.md), so any wallet
// that follows it can trade with MASKED.

export const SEAL_OUTPUT = 1;
export const SEAL_SATS = 1000;
/** Size used for the network fee (two Taproot inputs, four outputs, with room for the commitment). */
export const SWAP_SIZE_VB = 320;

const big = (v, what) => {
  const s = String(v ?? '');
  if (!/^\d{1,20}$/.test(s)) throw new Error(`${what} must be a whole number.`);
  return BigInt(s);
};

/** "txid:vout", lower case, or null. */
export function outpointOf(v) {
  const m = /^([0-9a-fA-F]{64}):(0|[1-9]\d{0,5})$/.exec(String(v ?? '').trim());
  return m ? `${m[1].toLowerCase()}:${m[2]}` : null;
}

/** The offer as the site sends it: { offerId?, assetId, amount, priceSats, state? }. */
export function readOffer(offer, offerId) {
  if (!offer || typeof offer !== 'object') throw new Error('The offer did not arrive with the request.');
  if (offer.offerId != null && String(offer.offerId) !== String(offerId)) throw new Error('The offer is for another id.');
  const assetId = String(offer.assetId || '');
  if (!/^rgb:[A-Za-z0-9~_\-!$.%]{10,120}$/.test(assetId)) throw new Error('The offer has no valid asset ID.');
  const amount = big(offer.amount, 'The offer amount'), priceSats = big(offer.priceSats, 'The price');
  if (amount <= 0n || priceSats <= 0n) throw new Error('The offer amount and price must be above zero.');
  return { offerId: String(offerId), assetId, amount, priceSats, state: offer.state ? String(offer.state) : '' };
}
export const changedTerms = (a, b) => String(a.assetId) !== String(b.assetId) || String(a.amount) !== String(b.amount) || String(a.priceSats) !== String(b.priceSats);

/** The smallest confirmed bitcoin output (from listUnspentsVanilla) holding more than `need` sats. */
export function buyerCoinFor(coins, need) {
  const want = BigInt(need);
  const ok = (coins || []).filter((c) => !c.is_spent && outpointOf(c.outpoint))
    .map((c) => ({ outpoint: outpointOf(c.outpoint), sats: BigInt(String(c.txout?.value ?? 0)) }))
    .filter((c) => c.sats > want)
    .sort((a, b) => (a.sats < b.sats ? -1 : a.sats > b.sats ? 1 : 0));
  return ok[0] ? { outpoint: ok[0].outpoint, sats: String(ok[0].sats) } : null;
}

/** vB one more taproot input adds to a transaction (a little over 57.5). */
export const EXTRA_INPUT_VB = 58;

/** vB of one input spending `script` (hex): taproot key path 57.5, P2WPKH 68, else a cautious 91. */
export const inputVb = (script = '5120') => (/^5120/.test(script) ? 57.5 : /^0014/.test(script) ? 68 : 91);
/** vB of one output paying `script` (hex): 8 for the amount, 1 for the length, then the script. */
export const outputVb = (script = '5120') => 9 + String(script).length / 2;

/**
 * The size of a transaction in vB, from its input and output scripts (hex): 10.5 for the version, counts, lock
 * time and segwit marker, then each input and output. Rounded up.
 * @param {string[]} inScripts @param {string[]} outScripts
 */
export function txVbytes(inScripts, outScripts) {
  return Math.ceil(10.5 + inScripts.reduce((t, s) => t + inputVb(s), 0) + outScripts.reduce((t, s) => t + outputVb(s), 0));
}
/** An OP_RETURN with a 32-byte RGB commitment, and a taproot output: for sizing. */
export const OPRET_SCRIPT = `6a20${'00'.repeat(32)}`;
export const P2TR_SCRIPT = `5120${'00'.repeat(32)}`;
/** An Instant purchase, sized before the coins are known: the seller's coin and `coins` of the buyer's (taproot). */
export const instantBuyVbytes = (coins = 1, change = true, payoutScript = P2TR_SCRIPT) =>
  txVbytes([P2TR_SCRIPT, ...Array(coins).fill(P2TR_SCRIPT)], [OPRET_SCRIPT, payoutScript, P2TR_SCRIPT, ...(change ? [P2TR_SCRIPT] : [])]);
/** Moving a listing's tokens (to their own output, or back when cancelling): the RGB coin and `coins` fee coins. */
export const instantMoveVbytes = (coins = 1) => txVbytes([P2TR_SCRIPT, ...Array(coins).fill(P2TR_SCRIPT)], [OPRET_SCRIPT, P2TR_SCRIPT, P2TR_SCRIPT]);

/**
 * Coins to pay `need` sats from the RGB wallet's bitcoin, so a trade never waits for the last one's change to
 * confirm: one confirmed coin if one is enough, else one coin counting unconfirmed change (this wallet's own
 * transactions), else several, largest first, up to `max`; each extra coin adds `perInput` sats of fee to `need`.
 * `confirmed` and `all` come from listUnspentsVanilla with 1 and 0 confirmations.
 * @returns {{ coins: { outpoint: string, sats: string }[], total: bigint } | null}
 */
export function payCoinsFor(confirmed, all, need, perInput = 0n, max = 4) {
  const one = buyerCoinFor(confirmed, need) || buyerCoinFor(all, need);
  if (one) return { coins: [one], total: BigInt(one.sats) };
  const list = (all || []).filter((c) => !c.is_spent && outpointOf(c.outpoint))
    .map((c) => ({ outpoint: outpointOf(c.outpoint), sats: BigInt(String(c.txout?.value ?? 0)) }))
    .sort((a, b) => (a.sats > b.sats ? -1 : a.sats < b.sats ? 1 : 0));
  const picked = []; let total = 0n;
  for (const c of list.slice(0, max)) {
    picked.push(c); total += c.sats;
    if (total > BigInt(need) + BigInt(perInput) * BigInt(picked.length - 1)) return { coins: picked.map((x) => ({ outpoint: x.outpoint, sats: String(x.sats) })), total };
  }
  return null;
}

const heldOn = (u, assetId) => (u.rgbAllocations || []).filter((a) => a.assetId === assetId && a.settled && a.assignment?.Fungible != null)
  .reduce((s, a) => s + BigInt(String(a.assignment.Fungible)), 0n);

/** The seller's RGB output holding the least of the asset that still covers `amount` (settled only). */
export function sellerCoinFor(unspents, assetId, amount) {
  const want = BigInt(amount);
  const ok = (unspents || []).filter((u) => u.utxo?.colorable && u.utxo.exists !== false)
    .map((u) => ({ u, held: heldOn(u, assetId) })).filter((x) => x.held >= want)
    .sort((a, b) => (a.held < b.held ? -1 : a.held > b.held ? 1 : 0))[0];
  if (!ok) return null;
  const o = ok.u.utxo.outpoint;
  return { outpoint: `${String(o.txid).toLowerCase()}:${o.vout}`, sats: String(ok.u.utxo.btcAmount) };
}

/**
 * Instant (pre-signed) listings: the seller's output must hold exactly the listed amount of one asset and nothing
 * else, because whoever completes the pre-signed transaction can take everything on that output. Returns it, or
 * null. `skip`: outputs already promised to other listings.
 */
export function exactCoinFor(unspents, assetId, amount, skip = new Set()) {
  const want = BigInt(amount);
  for (const u of unspents || []) {
    if (!u.utxo?.colorable || u.utxo.exists === false) continue;
    const o = u.utxo.outpoint, op = `${String(o.txid).toLowerCase()}:${o.vout}`;
    if (skip.has(op)) continue;
    const all = u.rgbAllocations || [];
    if (!all.length || all.some((a) => a.assetId !== assetId || !a.settled || a.assignment?.Fungible == null)) continue;
    if (heldOn(u, assetId) === want) return { outpoint: op, sats: String(u.utxo.btcAmount) };
  }
  return null;
}

/**
 * The amounts an Instant listing can sell with no move: each output holding only this asset, settled (what
 * exactCoinFor accepts). Largest first, each amount once, at most `limit`.
 */
export function instantAmounts(unspents, assetId, skip = new Set(), limit = 8) {
  const out = new Set();
  for (const u of unspents || []) {
    if (!u.utxo?.colorable || u.utxo.exists === false) continue;
    const o = u.utxo.outpoint, op = `${String(o?.txid).toLowerCase()}:${o?.vout}`;
    if (skip.has(op)) continue;
    const all = u.rgbAllocations || [];
    if (!all.length || all.some((a) => a.assetId !== assetId || !a.settled || a.assignment?.Fungible == null)) continue;
    const h = heldOn(u, assetId);
    if (h > 0n) out.add(h);
  }
  return [...out].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, limit).map(String);
}

/** sellerCoinFor without the outputs promised to Instant listings. */
export function freeSellerCoinFor(unspents, assetId, amount, skip = new Set()) {
  const free = (unspents || []).filter((u) => { const o = u.utxo?.outpoint; return !o || !skip.has(`${String(o.txid).toLowerCase()}:${o.vout}`); });
  return sellerCoinFor(free, assetId, amount);
}

/**
 * Outputs to pay `amount` from when sending (not swapping): the one smallest output that covers it, else the fewest
 * outputs, largest first, whose settled tokens add up to it (the engine spends them all and keeps the change).
 * Returns { coins, held } (held: the settled total, for the error when it's short) and coins null when short.
 */
export function sendCoinsFor(unspents, assetId, amount, skip = new Set()) {
  const want = BigInt(amount);
  const free = (unspents || []).filter((u) => { const o = u.utxo?.outpoint; return u.utxo?.colorable && u.utxo.exists !== false && !(o && skip.has(`${String(o.txid).toLowerCase()}:${o.vout}`)); })
    .map((u) => ({ u, held: heldOn(u, assetId) })).filter((x) => x.held > 0n);
  const held = free.reduce((t, x) => t + x.held, 0n);
  const coin = (x) => { const o = x.u.utxo.outpoint; return { outpoint: `${String(o.txid).toLowerCase()}:${o.vout}`, sats: String(x.u.utxo.btcAmount), held: x.held }; };
  const one = free.filter((x) => x.held >= want).sort((a, b) => (a.held < b.held ? -1 : a.held > b.held ? 1 : 0))[0];
  if (one) return { coins: [coin(one)], held };
  const coins = []; let got = 0n;
  for (const x of free.sort((a, b) => (a.held > b.held ? -1 : a.held < b.held ? 1 : 0))) { coins.push(coin(x)); got += x.held; if (got >= want) return { coins, held }; }
  return { coins: null, held };
}

/** Instant listing layout (engine: presign_sale): inputs 0 the buyer's, 1 the seller's; outputs 0 commitment, 1 payout, 2 the buyer's seal. */
export const INSTANT_SEAL_OUTPUT = 2;
/**
 * Sats on the seal output of an Instant purchase, and of the move to an output of its own: the dust limit of a
 * taproot output. (The four-step swaps keep SEAL_SATS, the value other wallets using that format expect.)
 */
export const INSTANT_SEAL_SATS = 330;

/** How much of an asset can be offered: in total, and the most on one output (one swap uses one output). */
export function offerable(unspents, assetId) {
  let total = 0n, max = 0n;
  for (const u of unspents || []) {
    if (!u.utxo?.colorable || u.utxo.exists === false) continue;
    const h = heldOn(u, assetId);
    total += h; if (h > max) max = h;
  }
  return { total: String(total), max: String(max) };
}

/** What the seller's output gets: the price, plus its RGB output's sats minus the buyer's seal. */
export function payoutFor(priceSats, sellerInputSats, sealSats = SEAL_SATS) {
  const extra = BigInt(sellerInputSats) - BigInt(sealSats);
  if (extra < 0n) throw new Error(`The RGB output holds ${sellerInputSats} sats, the buyer's seal needs ${sealSats}.`);
  return BigInt(priceSats) + extra;
}

/** The outputs the buyer expects (after the OP_RETURN). The seller's script is not the buyer's to check. */
export function buyerOutputs(session, sellerInputSats) {
  const price = BigInt(session.priceSats), fee = BigInt(session.feeSats);
  const change = BigInt(session.buyerInputSats) - price - fee;
  if (change < 0n) throw new Error('The prepared bitcoin no longer covers the price and the fee.');
  return [
    { script: session.buyerSeal, sats: SEAL_SATS },
    { script: null, sats: Number(payoutFor(price, sellerInputSats)) },
    { script: session.buyerChangeScript, sats: Number(change) },
  ];
}

/** The site must not hand the seller a PSBT that spends this wallet's outputs other than the one it coloured. */
export function completionBlocker({ sale, offer, txid, ownSpent }) {
  if (!sale) return 'This wallet did not prepare that sale.';
  if (changedTerms(sale, offer)) return 'The offer changed after the sale was prepared.';
  if (txid !== sale.txid) return 'This is not the transaction prepared for that sale.';
  if (ownSpent.length !== 1 || outpointOf(ownSpent[0]) !== sale.sellerOutpoint) return 'The transaction spends other outputs of this wallet than the sale\'s.';
  return null;
}

export const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const unb64 = (str) => { const s = atob(String(str || '')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
