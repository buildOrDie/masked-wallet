// Token transactions: mints, BRC2.0 reservations and deploys, token sends and transfer inscriptions.
import * as sp from '../crypto/sp-core.mjs';
import { CT_TEXT, DEFAULT_REVEAL_VALUE, DUST_CHANGE, TRANSFER_POSTAGE, describeEnvelope, envelopesIn, inscriptionScript } from '../ordinals/envelope.mjs';
import { checkAmount, checkTick, deriveSalt, jsonBody, mintBody, normTick, outpointBytes, predeployHash, transferBody } from '../ordinals/brc20.mjs';
import { RawTransaction } from '../bitcoin/RawTransaction.mjs';
import { normalizeSchnorrPriv, numsScriptOutput, p2trScript, xonly } from '../bitcoin/taproot.mjs';
import { compactSizeLength, dec, fromHex, lessThan, toHex, ZERO32 } from '../core/bytes.mjs';
import { inputOf } from '../wallet/TxBuilder.mjs';

const { b2n, mulG } = sp.util;

export class TokenTx {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  get account() { return this.app.account; }
  get coins() { return this.app.coins; }
  get book() { return this.app.tokens; }
  get builder() { return this.app.builder; }
  get deploys() { return this.app.deploys; }

  /** Mint; a self-mint ticker spends (and keeps) the deploy inscription as parent. */
  async mint({ from, tick, amt, recipient, rate }) {
    tick = tick.trim().toLowerCase(); checkTick(tick);
    amt = checkAmount(amt, 'Amount');
    const blocked = this.book.mintBlock(tick); if (blocked) throw new Error(blocked);
    const info = this.book.tickerInfo(tick)?.data;
    if (info?.max && !info.soldOut && Number(amt) > Number(info.max) - Number(info.minted)) throw new Error(`Only ${(Number(info.max) - Number(info.minted)).toLocaleString()} ${tick.toUpperCase()} left to mint.`);
    const dep = this.deploys.find(tick);
    if (dep && Number(amt) > Number(dep.lim)) throw new Error(`Max per mint for ${tick.toUpperCase()} is ${dep.lim}.`);
    if (dep?.selfMint) {
      // Self-mint: only mints inscribed as children of the deploy inscription count. We hold it, so we spend it as parent and keep it.
      const left = Number(dep.max) - this.book.mintedSoFar(tick);
      if (left <= 0) throw new Error(`The full ${tick.toUpperCase()} supply is already minted.`);
      if (Number(amt) > left) throw new Error(`Only ${left.toLocaleString()} ${tick.toUpperCase()} left to mint.`);
      const loc = dep.loc || { txid: dep.deployTxid, vout: 1 };
      const parent = this.coins.held(loc.txid, loc.vout);
      if (!parent) throw new Error('Your deploy inscription is not in this wallet yet. Tap refresh on Coins.');
      return this.builder.inscription({ from, body: mintBody(tick, amt), recipient, rate, parent, parentId: dep.deployId, meta: { op: 'mint', tick, amt, selfMint: true } });
    }
    return this.builder.inscription({ from, body: mintBody(tick, amt), recipient, rate, meta: { op: 'mint', tick, amt } });
  }

  /** Step 1 of a BRC2.0 deploy: reserve the ticker (kept secret by the hash). */
  async predeploy({ from, tick, max, lim, rate, resTo = 'shielded', selfMint = false }) {
    tick = tick.trim().toLowerCase(); checkTick(tick, { deploy: true });
    max = checkAmount(max, 'Max supply'); lim = selfMint ? max : checkAmount(lim, 'Limit per mint');
    if (Number(lim) > Number(max)) throw new Error('Limit per mint cannot be more than max supply.');
    if (this.deploys.list().some((d) => d.tick === tick && d.status !== 'failed')) throw new Error(`You already started ${tick.toUpperCase()}.`);
    if (resTo === 'shielded') return { ...(await this.shieldedPredeploy({ from, tick, max, lim, rate })), selfMint };
    const f = this.account.funding();
    if (!f) throw new Error('This wallet has no Public address.');
    const salt = deriveSalt(this.account.keys.bScan, tick, 0);
    const pkscript = toHex(p2trScript(f.outputX));
    const hash = predeployHash(tick, salt, pkscript);
    return this.builder.inscription({ from, body: jsonBody({ p: 'brc-20', op: 'predeploy', hash }), recipient: f.address, rate, meta: { op: 'predeploy', tick, max, lim, salt, hash, pkscript, selfMint } });
  }

  // Shielded reservation: the predeploy hash commits to the pkscript the reservation lands on. A silent-payment
  // output depends on the reveal's inputs, which contain that hash: a loop. It is broken the BIP 352 way:
  //  * the commit output's taproot internal key is the NUMS point, so it is NOT an eligible input;
  //  * an "anchor" coin we own is the only eligible input, and its outpoint must be the smallest one.
  // Then the shielded output depends only on the anchor and can be computed before the hash.
  async shieldedPredeploy({ from, tick, max, lim, rate }) {
    await this.coins.ensureOrd();
    if (!this.account.canSign) throw new Error('This wallet is watch-only and cannot inscribe.');
    const side = from === 'shielded' ? 'Shielded' : 'Public';
    const payList = this.coins.spendable(from);
    if (!payList.length) throw new Error(`Your ${side} balance is empty.`);
    const ownAddr = this.account.shieldAddr(), changeAddr = this.account.changeAddr();
    const REVEAL_VAL = DEFAULT_REVEAL_VALUE;
    for (let attempt = 0; attempt < 64; attempt++) {
      const salt = deriveSalt(this.account.keys.bScan, tick, attempt);
      const body = jsonBody({ p: 'brc-20', op: 'predeploy', hash: '0'.repeat(64) });
      // pick the coin that pays for the commit, and a different coin as the anchor (prefer Shielded)
      const commitFee = Math.ceil((10.5 + 57.5 + 43 + 43) * rate);
      const commitCoin = [...payList].sort((a, b) => a.sats - b.sats).find((c) => c.sats >= REVEAL_VAL + commitFee + DUST_CHANGE);
      if (!commitCoin) throw new Error(`Not enough ${side} balance for the reservation.`);
      const anchors = [...this.coins.shieldedSpendable(), ...this.coins.publicSpendable()].filter((c) => c.key !== commitCoin.key);
      const probe = inscriptionScript(ZERO32, CT_TEXT, body);
      const revealFee = Math.ceil((10.5 + 57.5 + 43 + (64 + compactSizeLength(body.length + probe.length) + body.length + probe.length + 65) / 4 + 1 + 57.5 + 43) * rate);
      const anchor = anchors.sort((a, b) => b.sats - a.sats).find((c) => c.sats - revealFee >= DUST_CHANGE);
      if (!anchor) throw new Error('A Shielded reservation needs two coins: one to pay and one more to anchor it. Shield part of your balance (not all), then try again.');
      const anchorPriv = this.builder.privOf(anchor);
      // shielded outputs depend only on the anchor (the commit input is NUMS → ineligible)
      const outs = sp.createOutputs([{ txid: anchor.txid, vout: anchor.vout, privKey: anchorPriv, taproot: true }], [{ txid: anchor.txid, vout: anchor.vout }], [ownAddr, changeAddr]);
      const resX = outs[0].output, chgX = outs[1].output;
      const pkscript = toHex(p2trScript(resX));
      const hash = predeployHash(tick, salt, pkscript);
      const realBody = jsonBody({ p: 'brc-20', op: 'predeploy', hash });
      const commitPriv = this.builder.privOf(commitCoin);
      const signPriv = normalizeSchnorrPriv(commitPriv);
      const script = inscriptionScript(xonly(mulG(b2n(signPriv))), CT_TEXT, realBody);
      const tap = numsScriptOutput(script);
      const commitOutputs = [{ value: REVEAL_VAL, script: p2trScript(tap.outputX) }];
      const change = commitCoin.sats - REVEAL_VAL - commitFee;
      let changeScript = p2trScript(commitCoin.output);
      if (from === 'shielded') changeScript = p2trScript(sp.createOutputs([{ txid: commitCoin.txid, vout: commitCoin.vout, privKey: commitPriv, taproot: true }], [{ txid: commitCoin.txid, vout: commitCoin.vout }], [changeAddr])[0].output);
      commitOutputs.push({ value: change, script: changeScript });
      const commitTx = new RawTransaction({ inputs: [inputOf(commitCoin)], outputs: commitOutputs });
      const commitTxid = commitTx.txid;
      // the anchor must be the smallest outpoint of the reveal, otherwise the address we hashed is wrong
      if (!lessThan(outpointBytes(anchor.txid, anchor.vout), outpointBytes(commitTxid, 0))) continue;
      const commitHex = commitTx.toHex([[commitTx.signKeyPath(0, commitPriv)]]);
      // reveal: input 0 = commit (envelope → inscription on sat 0 → output 0), input 1 = anchor (pays the fee)
      const revealTx = new RawTransaction({
        inputs: [{ txid: commitTxid, vout: 0, value: REVEAL_VAL, scriptPubKey: p2trScript(tap.outputX) }, inputOf(anchor)],
        outputs: [{ value: REVEAL_VAL, script: p2trScript(resX) }, { value: anchor.sats - revealFee, script: p2trScript(chgX) }],
      });
      const w0 = [revealTx.signScriptPath(0, signPriv, tap.leafHash), script, tap.controlBlock];
      const w1 = [revealTx.signKeyPath(1, anchorPriv)];
      const revealHex = revealTx.toHex([w0, w1]);
      const revealTxid = revealTx.txid;
      const estimate = { commitFee, revealFee, totalFee: commitFee + revealFee, revealValue: REVEAL_VAL, change };
      return {
        op: 'predeploy', tick, max, lim, salt, hash, pkscript, shieldedReservation: true,
        coin: commitCoin, from, recipient: ownAddr, kind: 'shielded', toSelf: true, body: dec.decode(realBody), estimate,
        commitHex, commitTxid, revealHex, revealTxid, revealOut: 0, inscriptionId: `${revealTxid}i0`, spent: [commitCoin.key, anchor.key],
      };
    }
    throw new Error('Could not line up the reservation. Try again.');
  }

  /** Step 2: the deploy, a child of the reservation (which comes back to us). */
  async deploy(d, { from, recipient, rate }) {
    let parent = this.coins.public.find((c) => c.txid === d.predeployTxid && c.vout === 0) || this.coins.shielded.find((c) => c.txid === d.predeployTxid && c.vout === 0);
    if (!parent) throw new Error('Reservation coin not found yet. Tap refresh on Coins.');
    if (!parent.privKey) parent = { ...parent, privKey: this.account.keys.outputPriv(parent.tweak), shielded: true };
    return this.builder.inscription({
      from, recipient, rate, parent, parentId: d.predeployId,
      body: jsonBody({ p: 'brc-20', op: 'deploy', tick: d.tick, max: d.max, lim: d.lim, ...(d.selfMint ? { self_mint: 'true' } : {}), salt: d.salt }),
      meta: { op: 'deploy', tick: d.tick, max: d.max, lim: d.lim, deployOf: d.tick },
    });
  }

  /**
   * Send tokens. A BRC-20 balance sits on the exact script that received it, so this takes two steps:
   *   1. inscribe {"op":"transfer"} ONTO that same script (commit + reveal);
   *   2. send that inscription to the recipient.
   * The reveal output carries a little extra so step 2 pays its own fee: no extra coin is needed and
   * the original mint coin is never touched.
   * `only: 'shielded'` takes the tokens from Shielded holders only; `holder` is an exact holder
   * { pkscript, amt, key } (the private trade address, whose balance comes from the token server).
   */
  async send({ tick, amt, to, from, rate, only = null, holder = null }) {
    tick = normTick(tick); checkTick(tick);
    amt = checkAmount(amt, 'Amount');
    const codec = this.account.codec, book = this.book;
    const k = codec.kind(to);
    if (k.kind !== 'public' && k.kind !== 'shielded') throw new Error(k.kind === 'empty' ? 'Enter who to send to.' : k.text + '.');
    const pubSpk = this.account.pubSpk();
    const all = holder ? [holder] : book.holdings(tick).filter((h) => !only || book.holderKey(h.pkscript)?.kind === only);
    const holds = all.map((h) => (h.pkscript === pubSpk ? { ...h, amt: Math.min(h.amt, book.transferAvail(tick)) } : h)).filter((h) => h.amt >= Number(amt)).sort((a, b) => a.amt - b.amt);
    if (!holds.length) {
      const max = all.reduce((a, h) => Math.max(a, h.amt), 0);
      const where = holder ? ' on your trade address' : only === 'shielded' ? ' in Shielded' : '';
      if (!where) throw new Error(max ? `You can send up to ${max.toLocaleString()} ${tick.toUpperCase()} in one transfer.` : `This wallet holds no ${tick.toUpperCase()} it can send.`);
      throw new Error(max ? `You can move up to ${max.toLocaleString()} ${tick.toUpperCase()}${where} in one transfer.` : `No ${tick.toUpperCase()}${where} that can be moved yet.`);
    }
    const h = holds[0];
    const key = h.key || book.holderKey(h.pkscript);
    if (!key) throw new Error('The coin holding this balance is not in the wallet yet. Tap refresh on Coins.');
    const fee2 = Math.ceil((10.5 + 57.5 + 43) * rate);
    // step 1: inscribe the transfer onto the holder script
    const ins = await this.builder.inscription({
      from, rate, recipient: '', rawRecipientScript: fromHex(h.pkscript), revealExtra: fee2,
      body: transferBody(tick, amt), meta: { op: 'tsend', tick, amt }, postage: TRANSFER_POSTAGE,
    });
    // step 2: move the transfer inscription to the recipient
    const tIn = { txid: ins.revealTxid, vout: ins.revealOut, value: ins.estimate.revealValue, scriptPubKey: fromHex(h.pkscript) };
    const outScript = k.kind === 'shielded'
      ? p2trScript(sp.createOutputs([{ txid: tIn.txid, vout: tIn.vout, privKey: key.priv, taproot: true }], [{ txid: tIn.txid, vout: tIn.vout }], [to])[0].output)
      : codec.outputScript(to);
    const sendTx = new RawTransaction({ inputs: [tIn], outputs: [{ value: TRANSFER_POSTAGE, script: outScript }] });
    const sendHex = sendTx.toHex([[sendTx.signKeyPath(0, key.priv)]]);
    return {
      ...ins, op: 'tsend', tick, amt, to, toKind: k.kind, fromSpk: h.pkscript, fromKind: key.kind, toSpk: toHex(outScript),
      toOwn: to === this.account.shieldAddr() || to === this.account.pubAddr(),
      sendHex, sendTxid: sendTx.txid, fee2, sendTotalFee: ins.estimate.totalFee + fee2,
    };
  }

  /** A transfer inscription on the Public address, ready to list on a marketplace or send. */
  async transferInscribe({ tick, amt, from, rate }) {
    tick = normTick(tick); checkTick(tick);
    amt = checkAmount(amt, 'Amount');
    const T = tick.toUpperCase(), avail = this.book.transferAvail(tick);
    if (Number(amt) > avail) {
      const shd = this.book.heldOn(tick, 'shielded');
      if (!avail && shd) throw new Error(`Your ${T} are in Shielded. Marketplaces only see your Public address: send them to your Public address first.`);
      throw new Error(avail ? `Only ${avail.toLocaleString()} ${T} available on your Public address.` : `No ${T} available on your Public address.`);
    }
    const ins = await this.builder.inscription({ from, rate, recipient: this.account.pubAddr(), body: transferBody(tick, amt), meta: { op: 'transfer', tick, amt }, postage: TRANSFER_POSTAGE });
    return { ...ins, op: 'transfer', tick, amt };
  }

  /** Rebuild the record of a reservation found on a coin (lost browser storage). Returns the ticker. */
  async recoverReservation(coin, { tick, max, selfMint, lim, salt: manualSalt }) {
    tick = normTick(tick); checkTick(tick, { deploy: true });
    max = checkAmount(max, 'Max supply'); lim = selfMint ? max : checkAmount(lim, 'Limit per mint');
    const r = await fetch(`${this.app.servers.base()}tx/${coin.txid}`);
    if (!r.ok) throw new Error('Could not load the reservation transaction.');
    const tx = await r.json();
    let hash = null;
    for (const v of tx.vin) for (const e of envelopesIn(v.witness || [])) { const d = describeEnvelope(e); if (d.op === 'predeploy') hash = d.hash; }
    if (!hash) throw new Error('No reservation found in that transaction.');
    const pkscript = tx.vout[coin.vout].scriptpubkey;
    const bScan = this.account.keys.bScan;
    const candidates = manualSalt ? [manualSalt.trim().toLowerCase()] : Array.from({ length: 64 }, (_, a) => deriveSalt(bScan, tick, a));
    const salt = candidates.find((x) => /^[0-9a-f]+$/.test(x) && predeployHash(tick, x, pkscript) === hash);
    if (!salt) throw new Error(manualSalt ? 'That salt does not match this reservation.' : `This reservation is not for ${tick.toUpperCase()}, or it was made by an older version with a random salt that is no longer stored. Check the ticker, or reserve again.`);
    this.deploys.save([...this.deploys.list().filter((d) => d.tick !== tick), { tick, max, lim, selfMint: !!selfMint, salt, hash, pkscript, predeployTxid: coin.txid, predeployId: `${coin.txid}i0`, height: tx.status?.confirmed ? tx.status.block_height : null, status: 'reserved', at: Date.now(), recovered: true }]);
    this.app.inscriptions.set(`${coin.txid}:${coin.vout}`, { brc20: true, op: 'predeploy', tick, hash, id: `${coin.txid}i0` });
    return tick;
  }
}
