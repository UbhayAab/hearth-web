// Pure helpers: DOM, escaping, markdown rendering, formatting.
// No app state lives here.
import MarkdownIt from 'https://esm.sh/markdown-it@14.1.0';
import DOMPurify from 'https://esm.sh/dompurify@3.1.6';
import hljs from 'https://esm.sh/highlight.js@11.10.0';

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

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (str, lang) => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(str, { language: lang }).value;
    } catch { /* fall through to escaped plain text */ }
    return md.utils.escapeHtml(str);
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') {
    n.setAttribute('target', '_blank');
    n.setAttribute('rel', 'noopener noreferrer');
  }
});

const SANITIZE = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'a', 'ul', 'ol', 'li',
    'blockquote', 'span', 'h1', 'h2', 'h3', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'],
  ALLOWED_ATTR: ['href', 'class', 'target', 'rel', 'src', 'alt', 'data-emoji'],
};

// Markdown + syntax highlight + sanitize, with @mentions, #channel links and
// :custom_emoji: carried through the pipeline as placeholders so markdown never
// mangles them and the sanitizer never strips them.
export function fmt(text, opts = {}) {
  text = text || '';
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
