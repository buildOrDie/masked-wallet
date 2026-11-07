// Display-time translation. Screens are written in English; just before HTML is put on the page, each sentence is
// looked up by its English text in the chosen language's dictionary. Anything not in the dictionary stays English,
// so a missing line never breaks a screen. Addresses, keys, amounts in .mono and anything marked translate="no"
// are never touched.
//
// Dictionary entries:
//   "Send": "发送"                                   plain text, matched whole (after trimming spaces)
//   "Available {0} {1}": "可用 {0} {1}"               {n} matches any text, carried over in the translation
//   "Tap <b>Receive</b> and send": "点击<b>接收</b>…"  a sentence with inline tags, matched as a whole
import { ZH_CN } from './zh-CN.mjs';

export const LANGS = Object.freeze({ en: 'English', 'zh-CN': '简体中文' });
export const LANG_KEY = 'masked.lang';
const DICTS = { 'zh-CN': ZH_CN };

let current = null;
/** The chosen language ('en' unless set). */
export function lang() {
  if (current) return current;
  try { current = localStorage.getItem(LANG_KEY) || 'en'; } catch { current = 'en'; }
  if (!LANGS[current]) current = 'en';
  return current;
}
export function setLang(code) {
  current = LANGS[code] ? code : 'en';
  try { localStorage.setItem(LANG_KEY, current); } catch { /* this session only */ }
  try { document.documentElement.lang = current === 'en' ? 'en' : current; } catch { /* not in a page */ }
}
/** For tests and the string collector. */
export function _setLangForTest(code) { current = code; }

// inline tags a sentence may contain and still be one unit
const INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 'br']);
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);
// never translated: translate="no", or a whole class name mono / addr / qr (addresses, keys, amounts)
const NO_TR = /translate="no"|class="(?:[^"]*\s)?(?:mono|addr|qr)(?:\s[^"]*)?"/i;
const ATTRS = /\b(placeholder|title|aria-label|alt)="([^"]*)"/g;

const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[e]);
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** A compiled dictionary: exact keys, and patterns (keys with {n}) longest first. */
function compile(dict) {
  const exact = new Map(), patterns = [];
  for (const [k, v] of Object.entries(dict)) {
    const key = squash(k);
    if (!/\{\d\}/.test(key)) { exact.set(key, v); continue; }
    const order = [];
    const re = new RegExp('^' + key.split(/(\{\d\})/).map((part) => {
      const m = /^\{(\d)\}$/.exec(part);
      if (m) { order.push(Number(m[1])); return '(.+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('') + '$', 's');
    patterns.push({ re, order, value: v, weight: key.replace(/\{\d\}/g, '').length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  return { exact, patterns };
}
const compiled = new Map();
function table(code) {
  if (!compiled.has(code)) compiled.set(code, compile(DICTS[code] || {}));
  return compiled.get(code);
}

/** Collector for the review file: every English sentence a screen showed without a translation. */
export const missing = new Set();
let collecting = false;
export function collectMissing(on) { collecting = on; }

/** Translate one sentence (plain text or HTML with inline tags). Returns null when the dictionary has nothing. */
function lookup(t, key) {
  const hit = t.exact.get(key);
  if (hit != null) return hit;
  for (const p of t.patterns) {
    const m = p.re.exec(key);
    if (!m) continue;
    // a pattern with little fixed text ("{0} mint{1}") must not swallow a long piece of some other sentence
    if (p.weight < 12 && m.slice(1).some((v) => v.length > 24)) continue;
    const vals = {};
    p.order.forEach((n, i) => { vals[n] = m[i + 1]; });
    // a value is translated too when it is a known word (Public, Shielded…)
    return p.value.replace(/\{(\d)\}/g, (_, n) => { const v = vals[n] ?? ''; return t.exact.get(squash(v)) ?? v; });
  }
  return null;
}

/** Translate a plain string (a toast, an error). */
export function tr(text, code = lang()) {
  if (code === 'en' || typeof text !== 'string' || !text.trim()) return text;
  const t = table(code), key = squash(text);
  const hit = lookup(t, key);
  if (hit == null && collecting) missing.add(key);
  return hit == null ? text : hit;
}

/** Translate rendered HTML. */
export function trHtml(html, code = lang()) {
  if (code === 'en' || typeof html !== 'string' || !html) return html;
  const t = table(code);
  const parts = html.split(/(<[^>]*>)/);
  const out = [];
  const stack = []; // open elements: { name, skip }
  const skipping = () => stack.some((e) => e.skip);
  let run = []; // a sentence: text and inline tags
  const flush = () => {
    if (!run.length) return;
    const raw = run.join('');
    run = [];
    if (!/[A-Za-z]{2,}/.test(raw.replace(/<[^>]*>/g, ''))) { out.push(raw); return; }
    const lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
    const hasTags = /<[^>]*>/.test(raw);
    if (hasTags) {
      // the whole sentence first; tags inside a sentence keep their attributes in the key
      const key = squash(decode(raw.replace(/\s*(<[^>]*>)\s*/g, (m, tag) => (m.startsWith(' ') ? ' ' : '') + tag + (m.endsWith(' ') ? ' ' : ''))));
      const hit = lookup(t, key);
      if (hit != null) { out.push(lead + hit + tail); return; }
      if (collecting) missing.add(key);
      // otherwise each text piece on its own
      for (const p of raw.split(/(<[^>]*>)/)) out.push(p.startsWith('<') ? p : translateText(p));
      return;
    }
    out.push(translateText(raw));
  };
  const translateText = (raw) => {
    const key = squash(decode(raw));
    if (!key || !/[A-Za-z]{2,}/.test(key)) return raw;
    const hit = lookup(t, key);
    if (hit == null) { if (collecting) missing.add(key); return raw; }
    return raw.match(/^\s*/)[0] + encode(hit) + raw.match(/\s*$/)[0];
  };
  for (const part of parts) {
    if (!part) continue;
    if (!part.startsWith('<')) { if (skipping()) out.push(part); else run.push(part); continue; }
    const m = /^<\s*(\/)?\s*([a-zA-Z][\w-]*)/.exec(part);
    const name = m ? m[2].toLowerCase() : '';
    const closing = !!m?.[1], selfClosing = /\/\s*>$/.test(part) || VOID.has(name);
    const tag = skipping() ? part : part.replace(ATTRS, (all, attr, val) => {
      const hit = val && /[A-Za-z]{2,}/.test(val) ? lookup(t, squash(decode(val))) : null;
      if (hit == null && collecting && val && /[A-Za-z]{2,}/.test(val)) missing.add(squash(decode(val)));
      return hit == null ? all : `${attr}="${encode(hit)}"`;
    });
    if (INLINE.has(name) && !skipping() && !NO_TR.test(part)) { run.push(tag); if (!closing && !selfClosing) stack.push({ name, skip: false }); else if (closing) popTo(name); continue; }
    flush();
    out.push(tag);
    if (closing) popTo(name);
    else if (!selfClosing) stack.push({ name, skip: NO_TR.test(part) || /^<(textarea|script|style|pre|code)\b/i.test(part) });
  }
  flush();
  return out.join('');
  function popTo(name) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) { stack.length = i; return; } }
}
