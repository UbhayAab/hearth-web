// Pure helpers: DOM, escaping, markdown rendering, formatting.
// No app state lives here.
//
// Nothing in this file is imported from a CDN at the top level any more. Every
// module named in a static import has to be fetched, parsed and evaluated before
// the module that imports it runs a single line, and this file sits on the path
// from index.html to the first painted message. markdown-it, its `entities`
// dependency, DOMPurify and highlight.js together were 526 KB across 226
// requests standing between a person on one bar of signal and their messages.
//
// They are still fetched immediately - the requests go out at module evaluation
// time, in parallel with everything else - they just no longer BLOCK. Text
// renders escaped and correct in the meantime, and every rendered body is
// repainted through the real pipeline the moment it arrives.

export const $ = (id) => document.getElementById(id);
export const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
export const esc = (s) =>
  (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- highlighting
// highlight.js is 458 KB across 195 requests from esm.sh - three quarters of the
// app's entire first load - and it does nothing at all until somebody posts a
// fenced code block. So it is not imported: the first code block renders as
// escaped plain text (correct, just unstyled), the module is fetched in the
// background, and every code block on the page is repainted when it lands.
//
// The one thing this must never do is put a network fetch on the path of a
// message that is about to be painted. It is fire-and-forget by construction.
const HLJS_URL = 'https://esm.sh/highlight.js@11.10.0';
let hljs = null;
let hljsPending = null;

function loadHljs() {
  if (hljs) return Promise.resolve(hljs);
  if (!hljsPending) {
    hljsPending = import(/* @vite-ignore */ HLJS_URL)
      .then((m) => { hljs = m.default || m; repaintCode(); return hljs; })
      .catch(() => null);     // no highlighting is a cosmetic loss, never an error
  }
  return hljsPending;
}

// Repaint every code block already on screen once the library arrives. The
// source is kept verbatim on a marker span inside the <code>, so this never
// re-parses markdown and never touches a block it did not render.
function repaintCode() {
  if (!hljs || typeof document === 'undefined') return;
  for (const mark of document.querySelectorAll('span[data-hl-src]')) {
    const host = mark.parentNode;
    const lang = mark.getAttribute('data-hl');
    const src = mark.getAttribute('data-hl-src');
    mark.remove();
    if (!host || !src) continue;
    try {
      if (lang && hljs.getLanguage(lang)) {
        host.innerHTML = hljs.highlight(decodeURIComponent(src), { language: lang }).value;
      }
    } catch { /* leave the escaped text as it is */ }
  }
}

// ---------------------------------------------------------------- markdown
let md = null;
let DOMPurify = null;
let mdPending = null;

function buildMarkdown(MarkdownIt, purify) {
  DOMPurify = purify;
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (n.tagName === 'A') {
      n.setAttribute('target', '_blank');
      n.setAttribute('rel', 'noopener noreferrer');
    }
  });
  md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight: (str, lang) => {
      try {
        if (hljs && lang && hljs.getLanguage(lang)) return hljs.highlight(str, { language: lang }).value;
      } catch { /* fall through to escaped plain text */ }
      if (!hljs) loadHljs();
      // Carry the source on the node so repaintCode() can highlight it in place.
      return `<span data-hl="${esc(lang || '')}" data-hl-src="${esc(encodeURIComponent(str))}"></span>`
        + md.utils.escapeHtml(str);
    },
  });
}

function loadMarkdown() {
  if (mdPending) return mdPending;
  mdPending = Promise.all([
    import(/* @vite-ignore */ 'https://esm.sh/markdown-it@14.1.0'),
    import(/* @vite-ignore */ 'https://esm.sh/dompurify@3.1.6'),
  ]).then(([M, D]) => {
    buildMarkdown(M.default || M, D.default || D);
    repaintMarkdown();
  }).catch(() => { /* escaped plain text is a correct, if plain, chat app */ });
  return mdPending;
}
loadMarkdown();       // fetched immediately; simply not awaited by first paint

// Anything rendered before markdown-it arrived carries its own source. Render it
// properly now. The render options are the same for every message on a page
// (the channel list and the current user's names), so the last ones seen are the
// right ones - there is no second context to get wrong.
let lastOpts = {};
function repaintMarkdown() {
  if (!md || typeof document === 'undefined') return;
  for (const n of document.querySelectorAll('[data-md-src]')) {
    const src = n.getAttribute('data-md-src');
    n.removeAttribute('data-md-src');
    if (!src) continue;
    try { n.outerHTML = fmt(decodeURIComponent(src), lastOpts); } catch { /* keep the plain text */ }
  }
}

const SANITIZE = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'a', 'ul', 'ol', 'li',
    'blockquote', 'span', 'h1', 'h2', 'h3', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'],
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'src', 'alt', 'data-emoji',
    'data-hl', 'data-hl-src'],
};

// ---------------------------------------------------------------- plain fast path
// Most messages in a working chat are one sentence with no markup at all, and
// running markdown-it + DOMPurify over them costs 2.3ms per row on a mid-range
// Android - a quarter of the whole cost of drawing a message. This decides,
// conservatively, whether a string can possibly be changed by that pipeline.
// Anything that even LOOKS like markup, a link, an email, a mention or a channel
// takes the real path; a false negative only costs speed, a false positive would
// mean unrendered markdown, so the test errs hard towards the slow path.
const MD_CHARS = /[\\`*_~[\]()<>|#@&!"']/;
const LINKY = /https?:|www\.|\.[a-z]{2,}([/?#]|$)/i;
const LINE_MARK = /(^|\n)[ \t]*([-+]\s|\d+[.)]\s|={2,}|-{2,}|:{3})/;
const isPlain = (t) => t.length < 2000 && !MD_CHARS.test(t) && !LINKY.test(t) && !LINE_MARK.test(t);

// Markdown + syntax highlight + sanitize, with @mentions, #channel links and
// :custom_emoji: carried through the pipeline as placeholders so markdown never
// mangles them and the sanitizer never strips them.
export function fmt(text, opts = {}) {
  text = text || '';
  lastOpts = opts;
  // markdown-it with breaks:true turns a newline into <br> and wraps the whole
  // thing in <p>. For a string with nothing to render, that is the entire
  // output, and we can produce it directly.
  if (!text) return '';
  if (isPlain(text)) return '<p>' + esc(text).replace(/\n/g, '<br>\n') + '</p>';
  // Markup, but the renderer has not landed yet. Escaped plain text is the
  // honest placeholder - it is the same escaping the sanitizer would apply, so
  // it is exactly as safe, just not as pretty - and it is repainted properly a
  // moment later. Never blocks, never throws away the source.
  if (!md) {
    loadMarkdown();
    return `<p data-md-src="${esc(encodeURIComponent(text))}">${esc(text).replace(/\n/g, '<br>\n')}</p>`;
  }
  const men = [];
  let toks = text.replace(/(^|\s)(@[\w][\w.-]*)/g, (m, pre, tag) => {
    men.push({ kind: 'user', raw: tag });
    return pre + '⁣M' + (men.length - 1) + '⁣';
  });
  toks = toks.replace(/(^|\s)(#[a-z0-9][a-z0-9_-]*)/gi, (m, pre, tag) => {
    men.push({ kind: 'channel', raw: tag });
    return pre + '⁣M' + (men.length - 1) + '⁣';
  });
  let html = md.render(toks);
  html = DOMPurify.sanitize(html, SANITIZE);
  html = html.replace(/⁣M(\d+)⁣/g, (m, i) => {
    const t = men[+i];
    if (!t) return '';
    if (t.kind === 'channel') {
      const name = t.raw.slice(1);
      const ch = (opts.channels || []).find((c) => c.name === name);
      return ch
        ? `<span class="chanlink" data-chan="${esc(ch.id)}">#${esc(name)}</span>`
        : `<span class="tag">${esc(t.raw)}</span>`;
    }
    const isMe = opts.meNames && opts.meNames.has(t.raw.slice(1).toLowerCase());
    return `<span class="tag${isMe ? ' tag-me' : ''}">${esc(t.raw)}</span>`;
  });
  return html;
}

// Plain-text preview (no markup) for quotes, notifications, search snippets.
export function plain(text, n = 120) {
  const s = (text || '').replace(/[*_`~>#]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export const timeOf = (d) =>
  new Date(d || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function dayOf(d) {
  const dt = new Date(d);
  const today = new Date();
  const y = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(dt, today)) return 'Today';
  if (same(dt, y)) return 'Yesterday';
  return dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function relTime(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const fmtSize = (n) =>
  n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : (n || 0) + ' B';

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function throttle(fn, ms) {
  let last = 0;
  return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } };
}

// Deterministic colour for an avatar / role chip from any id string.
export function hueOf(id) {
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function initials(name) {
  const parts = (name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}

// Local-time <input type="datetime-local"> value <-> ISO helpers.
export function toLocalInput(d) {
  const dt = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
