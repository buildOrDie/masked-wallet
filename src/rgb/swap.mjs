// Peer-to-peer RGB swaps: tokens for BTC in one Bitcoin transaction, nobody in the middle.
//
//   inputs   0  the seller's RGB output (holds the tokens)      1  the buyer's bitcoin
//   outputs  0  OP_RETURN (the RGB commitment)                  1  the buyer's seal: SEAL_SATS, receives the tokens
//            2  the seller: price + its input's sats − SEAL_SATS 3  the buyer's change
//
// The steps, each approved in the wallet doing it (the market only passes the messages on):
//   buyer  swapPrepare  → session (its invoice, seal, bitcoin input, change script, fee)
//   seller swapColor    → the PSBT with the RGB transfer, unsigned, and its consignment
//   buyer  swapSign     → checks the consignment and every output, then signs its input
//   seller swapFinish   → signs its input, broadcasts, posts the consignment to the buyer's transfer server
// The layout, field names and numbers match the Darkhorse wallet, so the two wallets can trade with each other.

export const SEAL_VOUT = 1;
export const SEAL_SATS = 1000;
/** Size used for the network fee (two Taproot inputs, four outputs, with room for the commitment). */
export const SWAP_VBYTES = 320;

const big = (v, what) => {
  const s = String(v ?? '');
  if (!/^\d{1,20}$/.test(s)) throw new Error(`${what} must be a whole number.`);
  return BigInt(s);
};

/** "txid:vout", lower case, or null. */
export function canonicalOutpoint(v) {
  const m = /^([0-9a-fA-F]{64}):(0|[1-9]\d{0,5})$/.exec(String(v ?? '').trim());
  return m ? `${m[1].toLowerCase()}:${m[2]}` : null;
}

/** The offer as the site sends it: { offerId?, assetId, amount, priceSats, state? }. */
export function offerOf(offer, offerId) {
  if (!offer || typeof offer !== 'object') throw new Error('The offer did not arrive with the request.');
  if (offer.offerId != null && String(offer.offerId) !== String(offerId)) throw new Error('The offer is for another id.');
  const assetId = String(offer.assetId || '');
  if (!/^rgb:[A-Za-z0-9~_\-!$.%]{10,120}$/.test(assetId)) throw new Error('The offer has no valid asset ID.');
  const amount = big(offer.amount, 'The offer amount'), priceSats = big(offer.priceSats, 'The price');
  if (amount <= 0n || priceSats <= 0n) throw new Error('The offer amount and price must be above zero.');
  return { offerId: String(offerId), assetId, amount, priceSats, state: offer.state ? String(offer.state) : '' };
}
export const termsDiffer = (a, b) => String(a.assetId) !== String(b.assetId) || String(a.amount) !== String(b.amount) || String(a.priceSats) !== String(b.priceSats);

/** The smallest confirmed bitcoin output (from listUnspentsVanilla) holding more than `need` sats. */
export function pickBuyerInput(coins, need) {
  const want = BigInt(need);
  const ok = (coins || []).filter((c) => !c.is_spent && canonicalOutpoint(c.outpoint))
    .map((c) => ({ outpoint: canonicalOutpoint(c.outpoint), sats: BigInt(String(c.txout?.value ?? 0)) }))
    .filter((c) => c.sats > want)
    .sort((a, b) => (a.sats < b.sats ? -1 : a.sats > b.sats ? 1 : 0));
  return ok[0] ? { outpoint: ok[0].outpoint, sats: String(ok[0].sats) } : null;
}

const heldOn = (u, assetId) => (u.rgbAllocations || []).filter((a) => a.assetId === assetId && a.settled && a.assignment?.Fungible != null)
  .reduce((s, a) => s + BigInt(String(a.assignment.Fungible)), 0n);

/** The seller's RGB output holding the least of the asset that still covers `amount` (settled only). */
export function pickSellerInput(unspents, assetId, amount) {
  const want = BigInt(amount);
  const ok = (unspents || []).filter((u) => u.utxo?.colorable && u.utxo.exists !== false)
    .map((u) => ({ u, held: heldOn(u, assetId) })).filter((x) => x.held >= want)
    .sort((a, b) => (a.held < b.held ? -1 : a.held > b.held ? 1 : 0))[0];
  if (!ok) return null;
  const o = ok.u.utxo.outpoint;
  return { outpoint: `${String(o.txid).toLowerCase()}:${o.vout}`, sats: String(ok.u.utxo.btcAmount) };
}

/** How much of an asset can be offered: in total, and the most on one output (one swap uses one output). */
export function sellable(unspents, assetId) {
  let total = 0n, max = 0n;
  for (const u of unspents || []) {
    if (!u.utxo?.colorable || u.utxo.exists === false) continue;
    const h = heldOn(u, assetId);
    total += h; if (h > max) max = h;
  }
  return { total: String(total), max: String(max) };
}

/** What the seller's output gets: the price, plus its RGB output's sats minus the buyer's seal. */
export function sellerPayout(priceSats, sellerInputSats, sealSats = SEAL_SATS) {
  const extra = BigInt(sellerInputSats) - BigInt(sealSats);
  if (extra < 0n) throw new Error(`The RGB output holds ${sellerInputSats} sats, the buyer's seal needs ${sealSats}.`);
  return BigInt(priceSats) + extra;
}

/** The outputs the buyer expects (after the OP_RETURN). The seller's script is not the buyer's to check. */
export function buyerView(session, sellerInputSats) {
  const price = BigInt(session.priceSats), fee = BigInt(session.feeSats);
  const change = BigInt(session.buyerInputSats) - price - fee;
  if (change < 0n) throw new Error('The prepared bitcoin no longer covers the price and the fee.');
  return [
    { script: session.buyerSeal, sats: SEAL_SATS },
    { script: null, sats: Number(sellerPayout(price, sellerInputSats)) },
    { script: session.buyerChangeScript, sats: Number(change) },
  ];
}

/** The site must not hand the seller a PSBT that spends this wallet's outputs other than the one it coloured. */
export function finishRefusal({ sale, offer, txid, ownSpent }) {
  if (!sale) return 'This wallet did not prepare that sale.';
  if (termsDiffer(sale, offer)) return 'The offer changed after the sale was prepared.';
  if (txid !== sale.txid) return 'This is not the transaction prepared for that sale.';
  if (ownSpent.length !== 1 || canonicalOutpoint(ownSpent[0]) !== sale.sellerOutpoint) return 'The transaction spends other outputs of this wallet than the sale\'s.';
  return null;
}

export const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const unb64 = (str) => { const s = atob(String(str || '')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
