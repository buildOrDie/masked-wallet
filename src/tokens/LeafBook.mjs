// LEAF (CRC-20, crc20.org) in the wallet: balances from crc20.org's read-only API, and transfers built in the
// one layout the protocol accepts. Mainnet only.
//
// Public: the balance belongs to the Public address; any free Public coin can be vin[0].
// Shielded: each silent payment lands on its own one-time address, so LEAF received there is held per
// address. vin[0] must be that address's coin (a small coin, kept out of normal sends). A partial send
// returns 330 sats to the same address in the same transaction, so the rest stays spendable.
//
// Privacy: asking crc20.org about Shielded addresses tells it they may belong together (same IP, same time).
// So by default only the Public address and Shielded addresses already known to hold LEAF (ones this wallet
// sent LEAF to) are looked up. Checking the other small Shielded coins is opt-in, per account.
import { RawTransaction } from '../bitcoin/RawTransaction.mjs';
import { p2trScript } from '../bitcoin/taproot.mjs';
import { fmtBtc } from '../core/format.mjs';
import { fetchWithin } from '../net/http.mjs';
import { DUST_CHANGE, INSCRIPTION_MAX } from '../ordinals/envelope.mjs';
import { SilentOutputs, inputOf } from '../wallet/TxBuilder.mjs';
import { LEAF_API, balanceFromReply, fmtLeaf, indexerSynced, leafScript, leafTransferOf, parseLeaf, receiverKind, vsizeOf } from './leaf.mjs';

const STALE_MS = 60_000;
const PENDING_MS = 3 * 86400_000; // forget an unconfirmed send after 3 days (it failed or was replaced)

export class LeafBook {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app @param {{ fetch?: typeof fetch }} [o] */
  constructor(app, o = {}) {
    this.app = app;
    this.fetch = o.fetch || ((input, init) => fetchWithin(12000, input, init));
    this.reset();
  }

  reset() {
    this.gen = (this.gen || 0) + 1; // a refresh started before a reset (another account) is thrown away
    /** @type {bigint|null} */ this.pub = null;
    /** Shielded addresses that hold LEAF: { address, atoms, coinKey|null } */
    this.sh = [];
    this.at = 0; this.busy = false; this.error = ''; this.behind = false;
    /** Unconfirmed LEAF transfers touching our addresses, from the mempool: { txid, from, to, atoms } */
    this.unconfirmed = [];
  }

  get on() { return this.app.state.net === 'main' && !!this.app.account.keys; }
  get account() { return this.app.account; }
  get store() { return this.app.store; }
  get pendingKey() { return `wren.leaf.pending.${this.account.id}`; }
  get seenKey() { return `wren.leaf.addrs.${this.account.id}`; }
  get scanKey() { return `wren.leaf.shielded.${this.account.id}`; }

  /** Opt-in: also ask crc20.org about this account's small Shielded coins (to find LEAF others sent you). */
  get scanShielded() { return this.store.get(this.scanKey) === '1'; }
  setScanShielded(on) { if (on) this.store.set(this.scanKey, '1'); else this.store.remove(this.scanKey); this.refresh(true); }
  /** A Shielded address now known to hold LEAF (we sent LEAF there ourselves). */
  remember(address) { if (address) this.store.setJson(this.seenKey, [...new Set([...this.seen(), address])]); }

  async get(path) {
    let r;
    for (let i = 0; i < 3; i++) {
      try { r = await this.fetch(`${LEAF_API}${path}`); }
      catch { throw new Error("Can't reach crc20.org right now."); }
      if (r.status !== 503 && r.status !== 429) break;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(j?.error?.message || `crc20.org error ${r.status}.`);
    return j;
  }

  balanceOf(address) { return this.get(`/addresses/${address}`).then(balanceFromReply); }

  // ---- in-flight sends: confirmed LEAF only counts after a block, so subtract what we already sent ----
  pending() {
    const now = Date.now();
    return (this.store.getJson(this.pendingKey, []) || []).filter((p) => now - p.at < PENDING_MS);
  }
  addPending(p) { this.store.setJson(this.pendingKey, [...this.pending(), { ...p, atoms: String(p.atoms), at: Date.now() }]); }
  /** LEAF on its way out of an address: our own sends not applied yet, plus any unconfirmed send seen in the mempool. */
  pendingFrom(address) {
    const out = new Map();
    for (const p of this.pending()) if (p.from === address) out.set(p.txid, BigInt(p.atoms));
    for (const u of this.unconfirmed) if (u.from === address) out.set(u.txid, u.atoms);
    return [...out.values()].reduce((a, v) => a + v, 0n);
  }
  /** LEAF on its way in to a side: unconfirmed transfers to our addresses (counted once they confirm). */
  incoming(side) {
    const mine = side === 'shielded' ? new Set(this.shieldedAddrs()) : new Set([this.account.pubAddr()]);
    return this.unconfirmed.filter((u) => mine.has(u.to) && !mine.has(u.from)).reduce((a, u) => a + u.atoms, 0n);
  }
  outgoing(side) {
    const addrs = side === 'shielded' ? this.sh.map((s) => s.address) : [this.account.pubAddr()];
    return addrs.reduce((a, x) => a + this.pendingFrom(x), 0n);
  }
  shieldedAddrs() { return this.app.coins.shielded.filter((c) => !c.example).map((c) => this.account.codec.trAddress(c.output)); }

  /** The Shielded coins crc20.org may be asked about: known LEAF addresses, plus small coins when opted in. */
  lookupCoins() {
    const seen = this.seen(), codec = this.account.codec;
    return this.app.coins.shielded.filter((c) => !c.example && (seen.has(codec.trAddress(c.output)) || (this.scanShielded && c.sats != null && c.sats <= INSCRIPTION_MAX)));
  }

  /** Unconfirmed LEAF transfers: the Public address's mempool, and the transactions of Shielded coins still pending. */
  async readMempool() {
    const base = this.app.servers.base(), found = new Map();
    const take = (tx) => { const t = leafTransferOf(tx); if (t) found.set(t.txid, t); };
    const pub = this.account.pubAddr();
    try {
      const r = await this.fetch(`${base}address/${pub}/txs/mempool`);
      if (r.ok) for (const tx of await r.json()) take(tx);
    } catch {}
    const txids = [...new Set(this.lookupCoins().filter((c) => c.pending).map((c) => c.txid))].slice(0, 10);
    for (const id of txids) {
      try { const r = await this.fetch(`${base}tx/${id}`); if (r.ok) { const tx = await r.json(); if (!tx.status?.confirmed) take(tx); } } catch {}
    }
    return [...found.values()];
  }

  /** Sends crc20.org has applied leave the in-flight list (their LEAF is gone from the confirmed balance). */
  /**
   * Reconcile in-flight sends with crc20.org's indexer. The list lives in storage, so it survives a restart
   * and an indexer that lags: a send stays reserved until one of these is true:
   * - crc20.org lists the transaction (200): the LEAF moved, the confirmed balance already shows it;
   * - the indexer is synced past the block that confirmed it and still has no LEAF operation for it (404):
   *   it broke a rule, so no LEAF moved and nothing is reserved any more;
   * - Bitcoin no longer knows the transaction an hour after it was sent (dropped or replaced).
   * A 503 (indexer catching up), a timeout, or an indexer not past that block yet keeps the reservation.
   * @param {{ synced?: boolean, height?: number }} [indexer] from /status
   */
  async settlePending(indexer = {}) {
    const list = this.pending();
    if (!list.length) return;
    const keep = [];
    for (const p of list) {
      let settled = false;
      try {
        const r = await this.fetch(`${LEAF_API}/transactions/${p.txid}`);
        if (r.status === 200) settled = true;
        else if (r.status === 404) {
          const s = await this.fetch(`${this.app.servers.base()}tx/${p.txid}/status`);
          if (s.status === 404) settled = Date.now() - p.at > 3600_000;
          else if (s.ok) {
            const st = await s.json();
            if (st.confirmed && indexer.synced && Number.isInteger(indexer.height) && indexer.height >= st.block_height) { settled = true; p.failed = true; }
          }
        }
      } catch {}
      if (!settled) keep.push(p);
      else if (p.failed) this.failedSends = [...(this.failedSends || []), p.txid];
    }
    this.store.setJson(this.pendingKey, keep);
  }

  /** Shielded addresses that have held LEAF, kept even when their coin is gone (the LEAF is still there). */
  seen() { return new Set(this.store.getJson(this.seenKey, []) || []); }

  /** Read every balance (Public, and each Shielded coin's address), at most 3 requests at a time. */
  async refresh(force = false) {
    if (!this.on || this.busy || (!force && Date.now() - this.at < STALE_MS)) return;
    this.busy = true;
    const gen = this.gen, id = this.account.id;
    const stale = () => gen !== this.gen || id !== this.account.id;
    try {
      const status = await this.get('/status');
      this.behind = !indexerSynced(status);
      await this.settlePending({ synced: !this.behind, height: status?.indexer?.height }); // first: a send applied meanwhile is then never counted twice the other way
      const { account } = this, codec = account.codec;
      const pubAddr = account.pubAddr();
      const coins = this.lookupCoins();
      const byAddr = new Map(coins.map((c) => [codec.trAddress(c.output), c]));
      for (const a of this.seen()) if (!byAddr.has(a)) byAddr.set(a, null);
      const addrs = [...byAddr.keys()];
      const found = [];
      let next = 0;
      const worker = async () => {
        while (next < addrs.length) {
          const a = addrs[next++];
          const atoms = await this.balanceOf(a);
          if (atoms > 0n) found.push({ address: a, atoms, coinKey: byAddr.get(a)?.key || null });
        }
      };
      const [pub, unconfirmed] = await Promise.all([pubAddr ? this.balanceOf(pubAddr) : Promise.resolve(0n), this.readMempool(), ...Array.from({ length: Math.min(3, addrs.length) }, worker)]);
      if (stale()) return; // the account or network changed meanwhile: these balances are not this one's
      this.pub = pub; this.unconfirmed = unconfirmed;
      this.sh = found.sort((x, y) => (y.atoms > x.atoms ? 1 : -1));
      this.store.setJson(this.seenKey, [...new Set([...this.seen(), ...found.map((f) => f.address)])]);
      this.at = Date.now(); this.error = '';
    } catch (e) {
      if (!stale()) this.error = e.message;
    } finally {
      if (gen === this.gen) this.busy = false;
      this.app.render();
    }
  }

  /** What a side can send now (confirmed balance less sends still in flight). */
  available(side) {
    if (side === 'shielded') return this.sh.reduce((a, s) => a + this.spendableAt(s), 0n);
    const p = this.pub ?? 0n, out = this.pendingFrom(this.account.pubAddr());
    return p > out ? p - out : 0n;
  }
  spendableAt(s) { const out = this.pendingFrom(s.address); return s.atoms > out ? s.atoms - out : 0n; }
  total(side) { return side === 'shielded' ? this.sh.reduce((a, s) => a + s.atoms, 0n) : (this.pub ?? 0n); }

  /** Largest Shielded amount one transaction can send (one address per transfer). */
  maxShieldedOnce() { return this.sh.filter((s) => s.coinKey).reduce((m, s) => { const v = this.spendableAt(s); return v > m ? v : m; }, 0n); }

  /**
   * A signed LEAF transfer, not broadcast.
   * @param {{ from: 'public'|'shielded', to: string, amount: string, rate: number }} o
   */
  async build({ from, to, amount, rate }) {
    const { app, account } = this, codec = account.codec;
    if (!this.on) throw new Error('LEAF works on Mainnet.');
    if (!account.canSign) throw new Error('This wallet is watch-only.');
    const atoms = parseLeaf(amount);
    if (!this.at) throw new Error('Checking your LEAF balance… try again in a moment.');
    const recipient = String(to || '').trim();
    const k = codec.kind(recipient);
    if (k.kind === 'empty') throw new Error('Enter who to send to.');
    if (k.kind !== 'public' && k.kind !== 'shielded') throw new Error(k.text + '.');
    const recv = k.kind === 'shielded' ? { kind: 'shielded', sats: 330 } : receiverKind(codec.outputScript(recipient));
    await app.coins.ensureOrd(from);

    // vin[0]: the sender
    let sender, senderAddress, partial = false;
    if (from === 'public') {
      senderAddress = account.pubAddr();
      if (atoms > this.available('public')) throw new Error(`Your Public LEAF is ${fmtLeaf(this.available('public'))}.`);
    } else {
      const src = this.sh.filter((s) => s.coinKey && this.spendableAt(s) >= atoms).sort((a, b) => (a.atoms > b.atoms ? 1 : -1))[0];
      if (!src) {
        const max = this.maxShieldedOnce();
        throw new Error(this.available('shielded') >= atoms && max > 0n
          ? `Your Shielded LEAF is in several places. One send can move up to ${fmtLeaf(max)}.`
          : `Your Shielded LEAF is ${fmtLeaf(this.available('shielded'))}.`);
      }
      const coin = app.coins.shielded.find((c) => c.key === src.coinKey);
      if (!coin) throw new Error('Refresh and try again.');
      sender = { ...coin, privKey: account.keys.outputPriv(coin.tweak) };
      senderAddress = src.address;
      partial = atoms < src.atoms;
    }

    // fee coins from the same side; Public may use one coin as both sender and fee payer
    const free = app.coins.spendable(from).map((c) => (from === 'shielded' ? { ...c, privKey: account.keys.outputPriv(c.tweak) } : c));
    const pool = [...free].sort((a, b) => b.sats - a.sats);
    if (from === 'public') {
      if (!pool.length) throw new Error('Sending LEAF needs a little BTC on your Public address for the fee.');
      sender = pool.shift();
    }
    const inputs = [sender];
    const changeTo = from === 'shielded' ? account.changeAddr() : null; // Shielded change stays Shielded

    const make = (fee) => {
      const inSum = inputs.reduce((a, c) => a + c.sats, 0);
      const fixed = recv.sats + (partial ? 330 : 0);
      const change = inSum - fixed - fee;
      const silent = [];
      if (recv.kind === 'shielded') silent.push(recipient);
      const withChange = change >= DUST_CHANGE;
      if (withChange && changeTo) silent.push(changeTo);
      const derived = silent.length ? new SilentOutputs(inputs.map((c) => ({ txid: c.txid, vout: c.vout, privKey: c.privKey, taproot: true })), inputs.map((c) => ({ txid: c.txid, vout: c.vout })), silent) : null;
      const outputs = [
        { value: 0, script: leafScript(atoms) },
        { value: recv.sats, script: recv.kind === 'shielded' ? derived.take(recipient) : codec.outputScript(recipient) },
      ];
      if (partial) outputs.push({ value: 330, script: p2trScript(sender.output) }); // keeps the rest of this address's LEAF spendable
      if (withChange) outputs.push({ value: change, script: changeTo ? derived.take(changeTo) : p2trScript(sender.output) });
      const tx = new RawTransaction({ inputs: inputs.map(inputOf), outputs });
      const hex = tx.toHex(inputs.map((c, i) => [tx.signKeyPath(i, c.privKey)]));
      return { tx, hex, change: withChange ? change : 0, fee: inSum - outputs.reduce((a, o) => a + o.value, 0), vsize: vsizeOf(hex, tx.toHex()) };
    };

    // add fee coins until the fee for the real size is covered
    for (;;) {
      const inSum = inputs.reduce((a, c) => a + c.sats, 0);
      const need = recv.sats + (partial ? 330 : 0);
      if (inSum > need) {
        const trial = make(Math.max(0, inSum - need - DUST_CHANGE)); // largest fee first, just to measure the size
        const sized = make(Math.ceil(vsizeOf(trial.hex, trial.tx.toHex()) * rate) + 2);
        const fee = Math.ceil(sized.vsize * rate);
        if (inSum - need >= fee) {
          const done = make(fee);
          if (done.fee >= Math.ceil(done.vsize * rate)) return { ...done, txid: done.tx.txid, atoms, from, recipient, receiverAddress: codec.fromScript(done.tx.outputs[1].script), kind: recv.kind === 'shielded' ? 'shielded' : 'public', senderAddress, partial, account: account.id, spent: inputs.map((c) => c.key) };
        }
      }
      const more = pool.shift();
      if (!more) throw new Error(`Not enough ${from === 'shielded' ? 'Shielded' : 'Public'} BTC for the network fee. Add about ${fmtBtc(2000)} ${account.unit}.`);
      inputs.push(more);
    }
  }

  /** Broadcast a built transfer and remember it as in flight. */
  async confirm(b) {
    if (b.account !== this.account.id) throw new Error('You switched account. Review the send again.');
    if (this.app.lookAlike(b.recipient) && !this.app.state.f.poisonOk) throw new Error('Tick the box to confirm the look-alike address.');
    await this.app.broadcast(b.hex);
    this.addPending({ txid: b.txid, from: b.senderAddress, atoms: b.atoms });
    // LEAF sent to our own Shielded address: remember that one-time address, so it is looked up (and only it)
    if (b.kind === 'shielded' && b.recipient.toLowerCase() === this.account.shieldAddr().toLowerCase()) this.remember(b.receiverAddress);
    this.unconfirmed = [...this.unconfirmed.filter((u) => u.txid !== b.txid), { txid: b.txid, from: b.senderAddress, to: b.receiverAddress, atoms: b.atoms }];
    this.app.rememberRecipient(b.recipient);
    this.app.state.f.poisonOk = false;
    this.app.afterBroadcast(b.spent, [b.txid]);
    setTimeout(() => this.refresh(true), 4000);
  }
}
