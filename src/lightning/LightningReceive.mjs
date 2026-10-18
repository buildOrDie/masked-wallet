// Receive over Lightning into the Shielded balance (Mainnet). Each receive is a Boltz reverse swap kept in a
// small record per wallet; `tick()` moves every open record along: waiting for payment → paid (Boltz's
// lockup seen) → claimed (our claim broadcast) → done. The claim only happens once the lockup has a
// confirmation on our own blockchain servers.
//
// A record holds no keys: the claim key and preimage come from the spend key and the record's nonce.
import { fromHex, randomHex, toHex } from '../core/bytes.mjs';
import { trAddress } from '../bitcoin/taproot.mjs';
import { readJson } from '../net/http.mjs';
import { BoltzApi } from '../net/BoltzApi.mjs';
import * as rs from './reverse-swap.mjs';

/** Open states (the ones `tick` still works on). */
const OPEN = new Set(['created', 'paid', 'claimed']);
const PAIR_TTL_MS = 60_000;
const FINAL_FAIL = new Set(['swap.expired', 'invoice.expired', 'transaction.failed', 'transaction.refunded']);

/**
 * @typedef {object} LnReceive
 * @property {string} id         Boltz swap id
 * @property {string} nonce      derives the claim key and preimage (with the spend key)
 * @property {number} sats       invoice amount
 * @property {number} onchain    what Boltz locks on-chain
 * @property {string} invoice
 * @property {string} lockupAddress
 * @property {string} refundPublicKey
 * @property {number} timeout    block height after which Boltz can take the lockup back
 * @property {number} created
 * @property {number} expiresAt  invoice expiry (ms)
 * @property {'created'|'paid'|'claimed'|'done'|'expired'|'failed'} state
 * @property {string} [status]   last Boltz status
 * @property {string} [lockupTxid]
 * @property {string} [claimTxid]
 * @property {string} [claimHex]
 * @property {number} [received] sats that landed in Shielded
 * @property {'key'|'script'} [path]  how the claim was signed
 * @property {string} [coopError]      why Boltz did not co-sign (script path)
 * @property {string} [error]
 */

export class LightningReceive {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app, api = new BoltzApi()) {
    this.app = app;
    this.api = api;
    this.pair = null;
    this.pairAt = 0;
    this.pairErr = '';
    this.pairBusy = false;
    this.ticking = false;
  }

  get account() { return this.app.account; }
  get key() { return `wren.ln.${this.account.id}`; }

  /** Lightning receive works on Mainnet, with the spend key, outside the demo wallet. */
  get available() { return this.account.net === 'main' && this.account.canTrade; }

  /** @returns {LnReceive[]} newest first */
  list() { return this.app.store.getJson(this.key, []) || []; }
  save(list) { this.app.store.setJson(this.key, list.slice(0, 50)); }
  get(id) { return this.list().find((r) => r.id === id) || null; }
  update(id, patch) {
    const list = this.list(), i = list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    this.save(list);
    return list[i];
  }
  open() { return this.list().filter((r) => OPEN.has(r.state)); }

  // ---- fees and limits ----

  /** Load Boltz's limits and fees (cached for a minute); re-renders when they arrive. */
  async loadPair(force = false) {
    if (this.pairBusy || (!force && this.pair && Date.now() - this.pairAt < PAIR_TTL_MS)) return this.pair;
    this.pairBusy = true;
    try { this.pair = await this.api.reversePair(); this.pairAt = Date.now(); this.pairErr = ''; } catch (e) { this.pairErr = e.message; } finally { this.pairBusy = false; }
    this.app.render();
    return this.pair;
  }

  /** The network fee our claim will pay at the current Avg rate. */
  claimFee() { return Math.ceil(rs.CLAIM_VSIZE * Math.max(1, this.app.fees.rates.normal)); }

  /** What arrives in Shielded for an invoice of `sats`, or null without fees yet. */
  estimate(sats) {
    if (!this.pair || !(sats > 0)) return null;
    const q = rs.quote(this.pair, sats);
    const claim = this.claimFee();
    return { ...q, claimFee: claim, receive: q.onchain - claim, min: this.pair.limits.minimal, max: this.pair.limits.maximal };
  }

  // ---- creating an invoice ----

  /** Ask Boltz for an invoice of `sats`, check everything it answers, and keep the record. */
  async create(sats) {
    if (!this.available) throw new Error('Lightning receive needs a Mainnet wallet with its recovery phrase.');
    if (!Number.isInteger(sats) || sats <= 0) throw new Error('Enter an amount in sats.');
    await this.app.fees.refresh().catch(() => {});
    const pair = await this.loadPair(true);
    if (!pair) throw new Error(this.pairErr || 'Lightning is not available right now.');
    const { minimal, maximal } = pair.limits;
    if (sats < minimal) throw new Error(`The smallest Lightning receive is ${minimal.toLocaleString()} sats.`);
    if (sats > maximal) throw new Error(`The largest Lightning receive is ${maximal.toLocaleString()} sats.`);
    const est = this.estimate(sats);
    if (est.receive < rs.DUST * 2) throw new Error('Too small: fees would take most of it. Try a larger amount.');

    const keys = this.account.keys;
    const nonce = randomHex(32);
    const s = rs.swapSecrets(keys.bSpend, nonce);
    const tipHeight = await this.app.sync.tipHeight();
    const res = await this.api.createReverse({ invoiceAmount: sats, preimageHash: toHex(s.preimageHash), claimPublicKey: toHex(s.claimPub), pairHash: pair.hash });
    const out = rs.verifyCreated({
      res, claimPub: s.claimPub, preimageHash: s.preimageHash, sats,
      minOnchain: est.onchain - 2, hrp: this.account.params.tr, lnNet: 'main', tipHeight,
    });
    /** @type {LnReceive} */
    const rec = {
      id: res.id, nonce, sats, onchain: out.onchain, invoice: res.invoice, lockupAddress: res.lockupAddress,
      refundPublicKey: res.refundPublicKey, timeout: out.timeout, created: Date.now(),
      expiresAt: (out.invoice.timestamp + out.invoice.expiry) * 1000, state: 'created', status: 'swap.created',
    };
    this.save([rec, ...this.list()]);
    return rec;
  }

  // ---- moving records along ----

  /** Check every open receive once. Safe to call often. */
  async tick() {
    if (this.ticking || !this.available || this.app.state.lockState !== 'open') return;
    const open = this.open();
    if (!open.length) return;
    this.ticking = true;
    let changed = false;
    try {
      for (const r of open) {
        const before = JSON.stringify(r);
        try { await this.step(r); } catch (e) { this.update(r.id, { error: e.message }); }
        if (JSON.stringify(this.get(r.id)) !== before) changed = true;
      }
    } finally { this.ticking = false; }
    if (changed) this.app.render();
  }

  /** @param {LnReceive} r */
  async step(r) {
    if (r.state === 'claimed') return this.confirmClaim(r);
    const st = await this.api.status(r.id);
    const status = String(st?.status || '');
    if (status !== r.status) this.update(r.id, { status, error: '' });
    if (FINAL_FAIL.has(status)) {
      this.update(r.id, { state: status.endsWith('expired') ? 'expired' : 'failed' });
      return undefined;
    }
    if (status === 'transaction.mempool') { this.update(r.id, { state: 'paid', lockupTxid: st.transaction?.id || r.lockupTxid }); return undefined; }
    if (status === 'transaction.confirmed' || status === 'invoice.settled') return this.claim(this.get(r.id));
    return undefined;
  }

  /** Rebuild the swap from our keys and the record (nothing from Boltz is reused unchecked). */
  swapOf(r) {
    const s = rs.swapSecrets(this.account.keys.bSpend, r.nonce);
    const boltzPub = fromHex(r.refundPublicKey);
    const out = rs.swapOutput({ preimageHash: s.preimageHash, claimPub: s.claimPub, boltzPub, timeout: r.timeout });
    if (r.lockupAddress.toLowerCase() !== trAddress(out.outputX, this.account.params.tr)) throw new Error('Stored swap does not match this wallet');
    return { s, out: { ...out, boltzPub } };
  }

  /** Claim the lockup into a silent payment to ourselves. */
  async claim(r) {
    const { s, out } = this.swapOf(r);
    const lock = await this.api.lockupTransaction(r.id);
    const lockup = rs.findLockup(String(lock?.hex || ''), out.spk, r.onchain);
    // the lockup must be confirmed according to our own servers, not just Boltz
    const base = this.app.servers.base();
    const status = await readJson(await fetch(`${base}tx/${lockup.txid}/status`), 'Lockup lookup');
    if (!status?.confirmed) { this.update(r.id, { state: 'paid', lockupTxid: lockup.txid }); return; }

    const keys = this.account.keys;
    const so = rs.selfSilentOutput({ bScan: keys.bScan, Bspend: keys.Bspend, outpoint: { txid: lockup.txid, vout: lockup.vout }, inputX: out.outputX });
    await this.app.fees.refresh().catch(() => {});
    const tx = rs.claimTx({ lockup, spk: out.spk, outputX: so.outputX, fee: this.claimFee() });
    let witness, path = 'key', coopError = '';
    try {
      const coop = rs.cooperativeClaim(tx, out, s.claimPriv, s.claimPub);
      const reply = await this.api.claimSignature(r.id, { transaction: tx.toHex(), preimage: toHex(s.preimage), pubNonce: coop.pubNonce });
      witness = coop.finish(reply);
    } catch (e) {
      coopError = e.message;
      witness = rs.scriptPathWitness(tx, out, s.claimPriv, s.preimage); // Boltz is not needed for this one
      path = 'script';
    }
    const hex = tx.toHex([witness]);
    // keep the signed claim first: if the broadcast fails it is sent again on the next tick
    this.update(r.id, { state: 'claimed', lockupTxid: lockup.txid, claimTxid: tx.txid, claimHex: hex, received: tx.outputs[0].value, path, coopError, error: '' });
    await this.broadcast(hex);
    await this.app.scanner.ingestTx(tx.txid);
    this.app.render();
  }

  async broadcast(hex) {
    try { await this.app.broadcast(hex); } catch (e) {
      if (/already|txn-already-known|known/i.test(e.message)) return;
      await this.api.broadcast(hex);
    }
  }

  /** After the claim: resend until the network has it, then done. */
  async confirmClaim(r) {
    const base = this.app.servers.base();
    const res = await fetch(`${base}tx/${r.claimTxid}/status`);
    if (res.ok) {
      const j = await res.json();
      if (j?.confirmed) { this.update(r.id, { state: 'done', claimHex: undefined }); return; }
      if (!this.app.coins.shielded.some((c) => c.txid === r.claimTxid)) await this.app.scanner.ingestTx(r.claimTxid);
      return;
    }
    if (r.claimHex) await this.broadcast(r.claimHex);
  }
}
