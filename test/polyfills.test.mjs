// AbortSignal.timeout / AbortSignal.any for old WebViews (Galaxy S9: WebView 101).
import test from 'node:test';
import assert from 'node:assert/strict';

test('AbortSignal.timeout and .any are filled in when missing, and behave', async () => {
  const keep = { timeout: AbortSignal.timeout, any: AbortSignal.any };
  delete AbortSignal.timeout; delete AbortSignal.any;
  try {
    assert.equal(typeof AbortSignal.timeout, 'undefined', 'removed for the test');
    await import('../src/core/polyfills.mjs?old');
    const t = AbortSignal.timeout(20);
    assert.equal(t.aborted, false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.aborted, true);
    assert.equal(t.reason?.name, 'TimeoutError');
    const a = new AbortController(), b = new AbortController();
    const both = AbortSignal.any([a.signal, b.signal]);
    b.abort('stop');
    assert.equal(both.aborted, true);
    assert.equal(both.reason, 'stop');
    const done = new AbortController(); done.abort('was');
    assert.equal(AbortSignal.any([done.signal]).reason, 'was');
  } finally { AbortSignal.timeout = keep.timeout; AbortSignal.any = keep.any; }
});
