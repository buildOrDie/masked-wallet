// Small fill-ins for older browsers. The phone app runs in Android System WebView, which on phones Google no longer
// updates can be years old (a Galaxy S9 on Android 9 has WebView 101, from 2022). The RGB engine times its requests
// with AbortSignal.timeout (Chrome 103+) and AbortSignal.any (Chrome 116+); without them every RGB request failed
// before it was sent ("Invalid indexer"). Each one is only added where the browser lacks it.

const AS = typeof AbortSignal !== 'undefined' ? AbortSignal : null;

if (AS && typeof AS.timeout !== 'function') {
  /** @param {number} ms */
  AS.timeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(typeof DOMException === 'function' ? new DOMException('signal timed out', 'TimeoutError') : undefined), ms);
    return c.signal;
  };
}

if (AS && typeof AS.any !== 'function') {
  /** @param {Iterable<AbortSignal>} signals */
  AS.any = (signals) => {
    const c = new AbortController();
    for (const s of signals) {
      if (!s) continue;
      if (s.aborted) { c.abort(s.reason); break; }
      s.addEventListener('abort', () => c.abort(s.reason), { once: true });
    }
    return c.signal;
  };
}
