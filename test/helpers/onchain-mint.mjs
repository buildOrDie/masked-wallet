// A test mint with NUT-30 on-chain deposits, in front of a real nutshell mint (FakeWallet backend).
// Everything else is passed through. On-chain quotes are kept here: a deposit is "confirmed" by calling
// POST /test/pay { quote | address, amount } (what a mint does once it sees the transaction confirm).
// Minting checks the NUT-20 signature with cashu-ts, then gets the blind signatures from nutshell by paying a
// bolt11 quote of the same amount, so the ecash is real.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { verifyMintQuoteSignature } from '@cashu/cashu-ts';

/** @param {{ upstream: string, address: (i: number) => string, port?: number }} o */
export async function startOnchainMint({ upstream, address, port = 0 }) {
  const quotes = new Map();
  let n = 0;
  const up = async (method, path, body) => {
    const r = await fetch(upstream + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const view = (q) => ({ quote: q.id, request: q.address, unit: 'sat', expiry: null, pubkey: q.pubkey, amount_paid: q.paid, amount_issued: q.issued });
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); res.end(JSON.stringify(j)); };
    try {
      if (req.method === 'OPTIONS') return send(204, {});
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/v1/info') {
        const { json } = await up('GET', '/v1/info');
        json.name = 'Test mint (on-chain)';
        json.nuts['4'].methods.push({ method: 'onchain', unit: 'sat', min_amount: 1000, options: { confirmations: 1 } });
        json.nuts['20'] = { supported: true };
        return send(200, json);
      }
      if (req.method === 'POST' && url.pathname === '/v1/mint/quote/onchain') {
        if (body?.unit !== 'sat' || !/^0[23][0-9a-f]{64}$/.test(body?.pubkey || '')) return send(400, { detail: 'pubkey required', code: 20007 });
        const q = { id: randomBytes(16).toString('hex'), address: address(n++), pubkey: body.pubkey, paid: 0, issued: 0 };
        quotes.set(q.id, q);
        return send(200, view(q));
      }
      const m = url.pathname.match(/^\/v1\/mint\/quote\/onchain\/([0-9a-f]+)$/);
      if (req.method === 'GET' && m) { const q = quotes.get(m[1]); return q ? send(200, view(q)) : send(404, { detail: 'quote not found' }); }
      if (req.method === 'POST' && url.pathname === '/v1/mint/onchain') {
        const q = quotes.get(body?.quote);
        if (!q) return send(400, { detail: 'quote not found' });
        if (!body.signature || !verifyMintQuoteSignature(q.pubkey, q.id, body.outputs, body.signature)) return send(400, { detail: 'Witness signature invalid', code: 20008 });
        const amount = body.outputs.reduce((a, o) => a + Number(o.amount), 0);
        if (amount > q.paid - q.issued) return send(400, { detail: 'amount exceeds what was paid', code: 20002 });
        const bq = await up('POST', '/v1/mint/quote/bolt11', { unit: 'sat', amount });
        const r = await up('POST', '/v1/mint/bolt11', { quote: bq.json.quote, outputs: body.outputs });
        if (r.status !== 200) return send(r.status, r.json);
        q.issued += amount;
        return send(200, r.json);
      }
      if (req.method === 'POST' && url.pathname === '/test/pay') {
        const q = body.quote ? quotes.get(body.quote) : [...quotes.values()].find((x) => x.address === body.address);
        if (!q) return send(404, { detail: 'no such quote' });
        q.paid += Number(body.amount);
        return send(200, view(q));
      }
      // everything else: the real mint
      const r = await up(req.method, url.pathname + url.search, body);
      return send(r.status, r.json);
    } catch (e) { return send(500, { detail: e.message }); }
  });
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), quotes };
}
