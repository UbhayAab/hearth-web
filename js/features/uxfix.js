// UX corrections.
//
// Everything here fixes a measured defect in the shipped interface rather than
// adding a product feature. It lives in one module because most of these
// corrections belong to files this agent does not own (js/core/*, js/ui.js,
// index.html) and would otherwise be unfixable at all; where a fix truly needs
// a core edit, the comment says so and this does the reachable part.
//
// Ordered roughly by how badly the defect hurt a non-technical volunteer on an
// Android phone on a patchy connection, which is the only audience that matters
// for this deployment.
//
// DELIBERATELY NOT HERE: the connection bar, the fetch intercept, delivery
// state on a message row, and the toast rewriting. features/offline.js owns all
// four. Two connection banners is worse than one, and two wrappers around
// window.fetch is a bug waiting to happen.

import { store, bus, nameOf } from '../store.js';
import { $, el, esc, plain, debounce, relTime } from '../util.js';
import { icon } from '../icons.js';
import { table } from '../api.js';
import { avatarHtml, applyEdit } from '../core/messages.js';
import { openChannel } from '../core/channels.js';

// --------------------------------------------------------------------------
// polish.css is not in index.html and index.html is not ours to edit. Injecting
// the link at module-evaluation time puts it after every other stylesheet in
// document order, which is exactly where it has to be: several of the defects it
// corrects are load-order bugs, where an earlier file was right and a broader
// selector in a later file happened to win.
// --------------------------------------------------------------------------
(function injectStyles() {
  try {
    if (document.querySelector('link[href*="polish.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('../../css/polish.css', import.meta.url).href;
    document.head.appendChild(l);
  } catch { /* the app is still usable unstyled; never take it down for CSS */ }
})();

const isTouch = () => window.matchMedia('(hover: none)').matches;

// ==========================================================================
// 1. HUMAN TEXT WHERE A RAW EXCEPTION WAS PAINTED
//
// offline.js rewrites toasts. Nothing rewrites the two places core writes an
// exception straight into the layout: the channel body (channels.js:221 sets
// the whole message list to `e.message`) and a nav section. A volunteer sees
// "TypeError: Failed to fetch" where their conversation was.
// ==========================================================================
const NET_RE = /failed to fetch|networkerror|network error|load failed|network request failed|err_(internet|network|connection)|fetch failed/i;
const RAW_RE = /^\s*(TypeError|ReferenceError|SyntaxError|AbortError)\b/;

export function humanError(msg) {
  const s = String(msg || '').trim();
  if (!s) return 'Something went wrong. Please try again.';
  if (NET_RE.test(s)) return 'Could not reach the server. Check your connection.';
  if (/abort|timed out|timeout/i.test(s)) return 'That took too long. Check your connection and try again.';
  if (/jwt|token is expired|not authenticated|invalid session/i.test(s)) {
    return 'Your sign-in has expired. Reload the page to sign in again.';
  }
  return s;
}

const looksRaw = (s) => NET_RE.test(s) || RAW_RE.test(s);

// A phone has no hover, so copy that tells someone to hover is copy that tells
// them to do something impossible. later.js is another agent's file; the string
// is corrected where it is rendered instead.
const COPY = [
  [/Hover any message, open (.+?) and pick/i, 'Press and hold a message, tap $1 and pick'],
  [/\bHover any message\b/gi, 'Press and hold a message'],
  [/\bhover over a message\b/gi, 'press and hold a message'],
];

function fixCopy(root) {
  if (!root || !isTouch()) return;
  // Marked whether or not anything was replaced. Before, a node that did not
  // match was re-tested on every single pass, and pass() runs on every mutation
  // of the message list - which on a phone means re-scanning every .muted node
  // in fifty messages a few times a second.
  for (const n of root.querySelectorAll('.empty, .muted')) {
    if (n.dataset.uxCopy) continue;
    n.dataset.uxCopy = '1';
    const before = n.textContent || '';
    let after = before;
    for (const [re, to] of COPY) after = after.replace(re, to);
    if (after !== before) n.textContent = after;
  }
}

function humanizeNode(root) {
  if (!root || root.nodeType !== 1) return;
  // Scoped to the two placeholder classes on purpose. Rewriting message bodies
  // would corrupt a real message that happens to contain the words.
  const targets = [...root.querySelectorAll('.empty, .muted.pad')];
  if (root.matches?.('.empty, .muted.pad')) targets.push(root);
  for (const t of targets) {
    if (t.dataset.uxHuman) continue;
    const txt = t.textContent || '';
    if (!looksRaw(txt)) continue;
    t.dataset.uxHuman = '1';
    t.textContent = humanError(txt);
  }
  fixCopy(root);
}

// ==========================================================================
// 2. A FAILED CHANNEL LOAD MUST NOT LOOK LIKE AN EMPTY CHANNEL
//
// openChannel wipes the message list before it fetches and, on failure,
// replaces the whole list with the raw exception. Going offline and switching
// channel therefore deleted every message on screen and printed
// "TypeError: Failed to fetch" where the conversation had been. To a volunteer
// that reads as "my messages are gone", which is the worst thing an app can
// say to somebody who is not sure it works.
//
// Keeping the old messages on screen needs an edit to js/core/channels.js:221.
// Turning the corpse into something honest and actionable does not, and neither
// does retrying by itself the moment the connection returns.
// ==========================================================================
let retryChannelId = null;

function renderLoadFailure(list, notice) {
  const c = store.current;
  retryChannelId = c?.id || null;
  const card = el('div', 'ux-fail');
  card.innerHTML = `
    <div class="ux-fail-title">Could not load ${c ? '#' + esc(c.name) : 'this conversation'}</div>
    <div class="ux-fail-sub">You are probably offline. Nothing has been lost - every
      message is still on the server, and this will load itself when you are back.</div>`;
  const b = el('button', 'sm', 'Try again');
  b.onclick = () => { if (retryChannelId) bus.emit('channel:request', { channelId: retryChannelId }); };
  card.appendChild(b);
  // Swap the corpse for the card IN PLACE. This used to be `list.innerHTML = ''`
  // followed by an append, which froze the whole app: bookmarks.js keeps its own
  // MutationObserver on #messages and re-inserts its bar the moment it is
  // removed, so wiping the list started a two-observer ping-pong that never let
  // the microtask queue drain. A phone with no signal locked up solid.
  if (notice && notice.parentElement === list) notice.replaceWith(card);
  else list.appendChild(card);
}

// ==========================================================================
// 3. SKELETONS
//
// --c-skeleton is defined for all three themes and .skeleton exists in
// base.css; grep found zero uses of either in any JS. Every load was the grey
// string "loading…" - including a channel switch, which at 400ms round trip is
// about a second of empty grey where the conversation used to be.
// ==========================================================================
const skRow = () => `<div class="ux-sk-row">
  <div class="ux-sk-av skeleton"></div>
  <div class="ux-sk-lines">
    <div class="ux-sk-line w-name skeleton"></div>
    <div class="ux-sk-line w-1 skeleton"></div>
    <div class="ux-sk-line w-2 skeleton"></div>
  </div></div>`;

const messageSkeleton = () =>
  `<div class="ux-sk-list" aria-hidden="true">${skRow().repeat(1)}${skRow()}${skRow()}${skRow()}${skRow()}</div>`;

const panelSkeleton = () => {
  const card = `<div class="ux-sk-card"><div class="ux-sk-av skeleton"></div>
    <div class="ux-sk-lines"><div class="ux-sk-line w-3 skeleton"></div>
    <div class="ux-sk-line w-2 skeleton"></div></div></div>`;
  return `<div class="ux-sk-panel" aria-hidden="true">${card.repeat(6)}</div>`;
};

// The stub is not always an only child - the bookmarks bar renders into the
// same list - so find it rather than assuming position.
const loadingStub = (host) => [...(host?.children || [])].find((n) =>
  n.classList?.contains('pad') && n.classList.contains('muted') &&
  /^(loading|searching)/i.test((n.textContent || '').trim()));

// A MutationObserver that writes to the DOM it observes is a freeze hazard by
// construction, and it does not even need a bug of its own: any OTHER module
// with an observer on the same node that restores what this one changed
// produces a two-party loop that never lets the microtask queue drain, and the
// tab locks up with no error and no way out. That happened - see the comment on
// renderLoadFailure - and on a phone with no signal it is unrecoverable.
//
// So the writes are behind a breaker. Nothing legitimate calls back 250 times in
// a second: a whole channel render is ONE callback, because the observer batches
// its records. If the breaker ever trips the app simply reverts to core's own
// behaviour, which is worse-looking and completely alive.
let armed = true;
function guarded(fn) {
  let hits = 0;
  let since = 0;
  return (...a) => {
    if (!armed) return undefined;
    const now = Date.now();
    if (now - since > 1000) { since = now; hits = 0; }
    if (++hits > 250) {
      armed = false;
      console.warn('[uxfix] mutation storm - decorations disabled for this session');
      return undefined;
    }
    return fn(...a);
  };
}

function watchLoading() {
  const list = $('messages');
  const panel = $('panelContent');

  const swap = (host, html) => {
    if (!host || host.querySelector('.ux-sk-list, .ux-sk-panel')) return;
    const stub = loadingStub(host);
    if (!stub) return;
    // Replace the stub in place so anything else already in the list survives.
    const box = el('div');
    box.innerHTML = html;
    stub.replaceWith(box.firstElementChild);
  };

  // A whole list that is nothing but a failure notice is a failed load, not an
  // empty channel. Matches both the raw exception core paints and the friendlier
  // sentence offline.js substitutes, because neither offers a way out.
  //
  // Scoped hard to the two placeholder classes core uses, and to nodes with no
  // id. Anything else in this list belongs to another feature - bookmarks.js
  // mounts #bmkBar here and re-inserts it from its OWN MutationObserver the
  // instant it is removed. Removing another module's node from inside an
  // observer is how you build an infinite loop out of two correct programs.
  const FAIL_RE = /no connection|check your connection|needs the internet|could not reach/i;
  const isPlaceholder = (n) => n.nodeType === 1 && !n.id &&
    (n.classList.contains('empty') || (n.classList.contains('muted') && n.classList.contains('pad')));
  const isFailureNotice = (n) => isPlaceholder(n) &&
    !n.classList.contains('ux-fail') &&
    (n.textContent || '').trim().length < 240 &&
    (looksRaw(n.textContent || '') || FAIL_RE.test(n.textContent || ''));

  const pass = () => {
    swap(list, messageSkeleton());
    swap(panel, panelSkeleton());
    if (list && !list.querySelector('.msg')) {
      const notices = [...list.children].filter(isFailureNotice);
      if (notices.length && !list.querySelector('.ux-fail')) renderLoadFailure(list, notices[0]);
      // Two sources can append a placeholder into this list, so the second one
      // lands after the card has replaced the first. Two copies of the same
      // apology is worse than one. Only ever our own placeholder classes.
      else for (const n of notices) n.remove();
    }
    humanizeNode(list);
    humanizeNode(panel);
    humanizeNode($('navExtra'));
    labelIconButtons(panel);
  };

  const obs = new MutationObserver(guarded(pass));
  if (list) obs.observe(list, { childList: true });
  if (panel) obs.observe(panel, { childList: true, subtree: true });
  const nav = $('navExtra');
  if (nav) obs.observe(nav, { childList: true, subtree: true });

  // Auto-heal. offline.js owns the banner; this owns the screen behind it.
  window.addEventListener('online', () => {
    if (retryChannelId && document.querySelector('.ux-fail')) {
      bus.emit('channel:request', { channelId: retryChannelId });
    }
  });
}

// ==========================================================================
// 4. THE LONG-PRESS MENU RENDERED ITS ICONS AS SOURCE CODE
//
// messages.js builds each menu label as `${a.label} ${a.title}` where a.label
// is icon markup, and ui.contextMenu escapes the label into text. So every row
// of the menu read `<svg class="ico" viewBox="0 0 24 24" ...>`. On a phone this
// menu is the ONLY path to reply-in-thread, quote, copy, pin and mark-unread -
// messages.css routes them here deliberately - so the entire action set was
// unusable on the primary form factor. Measured at 390x844: the menu was 1192px
// tall, positioned at y = -356, individual rows 251px.
//
// The real fix is two lines: ui.contextMenu taking {icon,label}, and messages.js
// passing them separately. Neither file is ours. Repairing the rendered menu is
// exact: the markup is our own icon() output, and it is re-parsed through an
// inert template with a strict allow-list before anything is trusted.
// ==========================================================================
const SVG_OK = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse']);

// Where the menu was actually asked for. ui.js has the event and this does not,
// so the coordinates are captured on the way past.
let lastPointer = { x: 0, y: 0 };
// Only remember a real position. A synthetic contextmenu - dispatched by a
// feature module, by an assistive technology, or by the keyboard path below -
// can arrive with no coordinates at all, and `undefined` propagated straight
// through Math.min into `style.top = "NaNpx"`, which the browser discards. The
// menu then fell back to its static position, which for a fixed element
// appended to <body> is directly below the app: entirely off the bottom of the
// screen, with no scrollbar to reach it.
const remember = (e) => {
  if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY) && (e.clientX || e.clientY)) {
    lastPointer = { x: e.clientX, y: e.clientY };
  }
};
document.addEventListener('pointerdown', remember, true);
document.addEventListener('contextmenu', remember, true);

function sanitizeIcon(markup) {
  const t = document.createElement('template');   // inert: nothing loads or runs
  t.innerHTML = markup;
  const root = t.content.firstElementChild;
  if (!root || root.tagName.toLowerCase() !== 'svg') return null;
  const walk = (n) => {
    for (const a of [...n.attributes]) {
      const nm = a.name.toLowerCase();
      if (nm.startsWith('on') || nm === 'href' || nm.endsWith(':href') || nm === 'style') {
        n.removeAttribute(a.name);
      }
    }
    for (const c of [...n.children]) {
      if (!SVG_OK.has(c.tagName.toLowerCase())) { c.remove(); continue; }
      walk(c);
    }
  };
  walk(root);
  root.setAttribute('aria-hidden', 'true');
  return root;
}

function repairCtxMenu(menu) {
  const items = [...menu.querySelectorAll('.ctx-item')];
  for (const item of items) {
    if (item.dataset.uxFixed) continue;
    item.dataset.uxFixed = '1';

    const raw = item.textContent || '';
    const m = raw.match(/^\s*(<svg[\s\S]*?<\/svg>)\s*([\s\S]*)$/);
    let label = (m ? m[2] : raw).trim();
    const svg = m ? sanitizeIcon(m[1]) : null;

    // A few feature modules still label their action with an emoji rather than
    // icon(), so the same split has to work for those or the glyph sits inside
    // the text with two spaces after it.
    let emoji = null;
    if (!svg) {
      const e = label.match(/^(\p{Extended_Pictographic}️?)\s+([\s\S]+)$/u);
      if (e) { emoji = e[1]; label = e[2].trim(); }
    }

    item.textContent = '';
    if (svg) item.appendChild(svg);
    else if (emoji) item.appendChild(el('span', 'ctx-emoji', esc(emoji)));
    else item.classList.add('ctx-noicon');
    item.appendChild(el('span', 'ctx-label', esc(label || 'Action')));

    // These were <div> with an onclick and nothing else: no role, no tab stop,
    // no key handling.
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
    });
  }
  menu.setAttribute('role', 'menu');

  // ui.js positioned this menu while it was 1192px tall, and clamps only its
  // BOTTOM edge - which is exactly what allows a negative top with the first
  // rows off screen. Now that the rows are one line each the menu is a fraction
  // of that height, so it has to be placed again from the pointer, clamping
  // both edges this time.
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // A clamp is only as good as its inputs, and an anchor that is off screen or
    // not a number has to end somewhere sensible rather than nowhere.
    const fit = (want, size, limit) => {
      const n = Number.isFinite(want) ? want : Math.round((limit - size) / 2);
      return Math.max(8, Math.min(n, Math.max(8, limit - size - 8)));
    };
    menu.style.left = fit(lastPointer.x, r.width, vw) + 'px';
    menu.style.top = fit(lastPointer.y, r.height, vh) + 'px';
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const n = e.key === 'ArrowDown' ? i + 1 : i - 1;
    items[(n + items.length) % items.length]?.focus();
  });
  appendFolded(menu);
  if (!isTouch()) setTimeout(() => items[0]?.focus(), 0);
}

// ==========================================================================
// 5. OPENING A CHANNEL WITH UNREAD MESSAGES
//
// openChannel calls scrollDown() unconditionally, so an unread channel opens at
// the END of a conversation you have not read, with the "New messages" divider
// somewhere above and off screen. The divider's only control was "Jump to
// newest", which takes you further away from the thing you came to read.
//
// Deferring markRead until the reader reaches the bottom needs a core edit
// (channels.js:243). Landing on the divider does not.
// ==========================================================================
let jumpArmed = null;
let jumpTimer = null;

function armUnreadJump(channelId) {
  clearTimeout(jumpTimer);
  quietList();                       // do not read the whole page out loud
  document.querySelector('.ux-unread-top')?.remove();
  if (!channelId) { jumpArmed = null; return; }
  // store.unread still holds the pre-open value here: channel:open is emitted
  // before core fetches the page and marks the channel read.
  jumpArmed = store.unread.get(channelId)?.unread > 0 ? channelId : null;
  // If the divider never arrives - everything on this page is already read -
  // stop waiting rather than jumping a minute later out of nowhere.
  if (jumpArmed) jumpTimer = setTimeout(() => { jumpArmed = null; }, 6000);
}

function tryUnreadJump() {
  if (!jumpArmed || store.current?.id !== jumpArmed) return;
  const list = $('messages');
  const div = list?.querySelector('.mx-newdiv');
  if (!div) return;
  jumpArmed = null;
  clearTimeout(jumpTimer);
  // block:'start' plus the list's own scroll-padding-top keeps the divider clear
  // of the pills that float over the top of the list.
  div.scrollIntoView({ block: 'start', behavior: 'auto' });
  paintUnreadPill();
}

// A pill that goes UP to the first unread. The divider had a button that only
// went down.
function paintUnreadPill() {
  const list = $('messages');
  const host = list?.parentElement;
  if (!list || !host) return;
  const div = list.querySelector('.mx-newdiv');
  const pill = host.querySelector('.ux-unread-top');

  const above = div && div.getBoundingClientRect().top < list.getBoundingClientRect().top + 8;
  if (!div || !above) { pill?.remove(); return; }
  if (pill) return;

  const b = el('button', 'ux-unread-top', `${icon('arrowDown')}<span>Jump to first unread</span>`);
  b.setAttribute('aria-label', 'Jump to the first unread message');
  b.onclick = () => {
    list.querySelector('.mx-newdiv')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    b.remove();
  };
  host.appendChild(b);
}

// ==========================================================================
// 6. KEYBOARD AND SCREEN READERS
//
// Measured on a signed-in desktop page: 0 elements with a role, 0 with
// aria-live, and 0 of 5 channel rows reachable by Tab. Primary navigation was
// keyboard-inaccessible. Message actions were unreachable because .msg was not
// focusable, so messages.css's own `.msg:focus-within > .actions` could never
// fire. Modal focus escaped into the page behind the dialog after two tabs.
// Error toasts were silent to a screen reader.
// ==========================================================================
let lastFocusedChannel = null;

function wireChannelList() {
  const host = $('channels');
  if (!host) return;
  const rows = () => [...host.querySelectorAll('.chan')];

  const apply = () => {
    const all = rows();
    if (!all.length) return;
    for (const r of all) {
      if (r.dataset.uxNav) continue;
      r.dataset.uxNav = '1';
      r.setAttribute('role', 'listitem');
      r.setAttribute('aria-label', r.querySelector('.ch-name')?.textContent?.trim() || 'channel');
      r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.click(); return; }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const list = rows();
        const at = list.indexOf(r);
        const next = list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
        if (next) { next.tabIndex = 0; next.focus(); }
      });
      r.addEventListener('focus', () => { lastFocusedChannel = r.dataset.ch || r.dataset.dm || null; });
    }
    // Roving tabindex: one tab stop for the whole list, arrows move inside it.
    // Forty channels should not be forty stops before you reach a message.
    const activeIdx = Math.max(0, all.findIndex((r) => r.classList.contains('active')));
    all.forEach((r, i) => {
      r.tabIndex = i === activeIdx ? 0 : -1;
      if (r.classList.contains('active')) r.setAttribute('aria-current', 'true');
      else r.removeAttribute('aria-current');
    });
  };

  host.setAttribute('role', 'list');
  apply();

  // wireChannelList runs again on every `workspace` and `channels` event, and
  // without this guard each of those attached ANOTHER observer to the same node
  // - so after five Space switches every sidebar repaint ran apply() five times.
  // A volunteer in two organisations switches Space all day.
  if (host.dataset.uxObserved) return;
  host.dataset.uxObserved = '1';

  // refreshUnread() rebuilds this list with innerHTML four times a minute, which
  // destroys focus mid-interaction. Restoring it is the reachable half; the
  // other half - diffing rows instead of replacing them - is a change to
  // js/core/channels.js:438.
  new MutationObserver(guarded(() => {
    apply();
    if (!lastFocusedChannel) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const sel = `[data-ch="${CSS.escape(lastFocusedChannel)}"],[data-dm="${CSS.escape(lastFocusedChannel)}"]`;
    const back = host.querySelector(sel);
    if (back) { back.tabIndex = 0; back.focus(); }
  })).observe(host, { childList: true, subtree: true });
}

// ==========================================================================
// THE DESKTOP ACTION BAR GROWS WITH THE FEATURE REGISTRY
//
// Measured at 1440px: 14 buttons, 480px - 44% of the reading column - hanging
// over the message above. Capping the quick reactions at three took it to 11,
// and then two more feature modules registered actions and it was 13 again.
// Trimming by CSS position is a losing game, because the number of registered
// actions is exactly the thing that keeps changing.
//
// So fold it from the DOM instead: three reactions, the picker, the first two
// actions, and the ⋯ that was always last. The folded buttons are appended to
// the ⋯ menu when it opens, so there is ONE overflow rather than two, and the
// fold proxies the real buttons - it needs to know nothing about the registry
// and cannot go stale when a feature is added or removed.
// ==========================================================================
let UI = null;
let pendingFold = null;

function foldActionBar(row) {
  if (isTouch()) return;                 // touch already keeps only two controls
  const bar = row.querySelector('.actions');
  if (!bar) return;
  const btns = [...bar.children];
  // upgradeMessageRow rebuilds this bar from scratch after the server answers,
  // with the same number of buttons - so a count alone reports "already done"
  // over a bar whose buttons are all brand new and unmarked. Check that the mark
  // actually survived.
  if (bar.dataset.uxFold === String(btns.length) && bar.querySelector('.ux-ovf')) return;
  bar.dataset.uxFold = String(btns.length);
  for (const b of btns) b.classList.remove('ux-ovf');

  const quick = btns.filter((b) => b.classList.contains('quick')).length;
  const rest = btns.slice(quick + 1);   // the emoji picker sits right after the run
  const more = rest.pop();              // core registers `more` at order 900, always last
  const fold = rest.slice(2);
  if (!more || fold.length < 2) return; // folding one button saves nothing

  for (const b of fold) b.classList.add('ux-ovf');
  // Capture phase, so the list is waiting before core's own onclick builds the
  // menu and the observer repairs it.
  more.addEventListener('click', () => { pendingFold = fold; }, true);
}

// Append the folded actions to the ⋯ menu core just built. Built as real nodes
// rather than as an escaped label, because at this point the repair pass has
// already run.
function appendFolded(menu) {
  const fold = pendingFold;
  pendingFold = null;
  if (!fold?.length) return;
  // Core's fixed menu and the action registry overlap - both offer "Pin to
  // channel" and "Mark unread from here" - and side by side that duplication is
  // suddenly visible. Keep the copy that was already there.
  const already = new Set([...menu.querySelectorAll('.ctx-label')]
    .map((n) => n.textContent.trim().toLowerCase()));
  const add = fold.filter((b) => !already.has((b.title || '').trim().toLowerCase()));
  if (!add.length) return;
  menu.appendChild(el('div', 'ctx-sep'));
  for (const b of add) {
    const item = el('div', 'ctx-item');
    item.dataset.uxFixed = '1';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    const svg = sanitizeIcon(b.innerHTML);
    if (svg) item.appendChild(svg);
    else item.classList.add('ctx-noicon');
    item.appendChild(el('span', 'ctx-label', esc(b.title || 'Action')));
    item.onclick = () => { menu.remove(); b.click(); };
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
    });
    menu.appendChild(item);
  }
}

function decorateMessage(r) {
  foldActionBar(r);
  if (r.dataset.uxMsg) return;
  r.dataset.uxMsg = '1';
  r.tabIndex = -1;
  r.setAttribute('role', 'article');
  const who = r.querySelector('.who')?.textContent?.trim();
  const body = r.querySelector('.body')?.textContent?.trim();
  if (who || body) r.setAttribute('aria-label', `${who || 'Message'}: ${plain(body || '', 120)}`);
}

// A live region is what makes an arriving message audible. It is also what
// makes a channel switch read FIFTY messages aloud, because opening a channel
// replaces the whole region at once and every one of those rows is an
// "addition". So the region is silenced while a page is being painted and comes
// back once the list has been quiet for half a second. Announcing everything is
// worse than announcing nothing: it is the behaviour that makes people turn the
// screen reader off.
let liveTimer = null;
let quietSince = 0;
function goLive() {
  const list = $('messages');
  if (list) list.setAttribute('aria-live', 'polite');
}
function quietList() {
  const list = $('messages');
  if (!list) return;
  list.setAttribute('aria-live', 'off');
  quietSince = Date.now();
  clearTimeout(liveTimer);
  liveTimer = setTimeout(goLive, 600);
}
function nudgeLive() {
  const list = $('messages');
  if (!list || list.getAttribute('aria-live') !== 'off') return;
  // Waiting for a quiet gap is right for the burst of a page paint and wrong
  // forever: a busy channel would keep pushing the deadline out and never
  // announce anything again. Three seconds is the hard ceiling on the silence.
  if (Date.now() - quietSince > 3000) { clearTimeout(liveTimer); goLive(); return; }
  clearTimeout(liveTimer);
  liveTimer = setTimeout(goLive, 600);
}

function wireMessageList() {
  const list = $('messages');
  if (!list || list.dataset.uxWired) return;
  list.dataset.uxWired = '1';
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  list.setAttribute('aria-relevant', 'additions');
  list.setAttribute('aria-label', 'Conversation');
  list.tabIndex = 0;

  list.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    const all = [...list.querySelectorAll('.msg')];
    if (!all.length) return;
    const cur = document.activeElement?.closest?.('.msg') || null;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = cur ? all.indexOf(cur) : (e.key === 'ArrowDown' ? -1 : all.length);
      const next = all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      next?.focus();
      return;
    }
    // The action bar is a hover affordance. From the keyboard the way in is the
    // same menu a long press opens, which is one thing to learn instead of two.
    if (cur && (e.key === 'Enter' || e.key === 'ContextMenu')) {
      e.preventDefault();
      const r = cur.getBoundingClientRect();
      cur.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: Math.max(8, r.right - 40), clientY: r.top + 12,
      }));
    }
  });

  new MutationObserver(guarded((recs) => {
    for (const rec of recs) {
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList?.contains('msg')) decorateMessage(n);
        const own = n.closest?.('.msg');
        if (own) decorateMessage(own);          // upgradeMessageRow rebuilt the bar
        for (const r of n.querySelectorAll?.('.msg') || []) decorateMessage(r);
        // Every action button in a row is an SVG with no text. They are built
        // fresh for each message and again by upgradeMessageRow, so labelling
        // once at boot reaches almost none of them.
        labelIconButtons(n.querySelectorAll ? n : list);
      }
    }
    nudgeLive();
    tryUnreadJump();
  })).observe(list, { childList: true, subtree: true });

  for (const r of list.querySelectorAll('.msg')) decorateMessage(r);
  list.addEventListener('scroll', debounce(paintUnreadPill, 120));
}

let dlgSeq = 0;
function trapModal(back) {
  const box = back.querySelector('.modal');
  if (!box || box.dataset.uxTrap) return;
  box.dataset.uxTrap = '1';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const title = box.querySelector('.modal-head strong');
  if (title) {
    if (!title.id) title.id = 'ux-dlg-' + (++dlgSeq);
    box.setAttribute('aria-labelledby', title.id);
  }
  box.querySelector('.modal-head button.icon')?.setAttribute('aria-label', 'Close');

  const prev = document.activeElement;
  const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'
    + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  // Measured before this: Tab left the dialog after two stops and walked the
  // page behind it - Invite, then the header buttons.
  back.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll(SEL)].filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  const watch = new MutationObserver(() => {
    if (back.isConnected) return;
    watch.disconnect();
    try { prev?.focus?.(); } catch { /* the element may be gone */ }
  });
  watch.observe(document.body, { childList: true });
}

// One observer for everything appended straight to <body>: the toast host, the
// long-press menu and every modal.
function wireBodyAdditions() {
  new MutationObserver(guarded((recs) => {
    for (const rec of recs) {
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1) continue;
        try {
          if (n.classList.contains('toasts')) {
            n.setAttribute('role', 'status');
            n.setAttribute('aria-live', 'polite');
            n.setAttribute('aria-atomic', 'false');
          }
          if (n.classList.contains('ctxmenu')) repairCtxMenu(n);
          if (n.classList.contains('modal-back')) { trapModal(n); humanizeNode(n); }
          if (n.classList.contains('popover') || n.classList.contains('modal-back')) labelIconButtons(n);
        } catch { /* never let a decoration break the thing it decorates */ }
      }
    }
  })).observe(document.body, { childList: true });
}

function addSkipLink() {
  if (document.querySelector('.ux-skip')) return;
  const a = el('a', 'ux-skip', 'Skip to the conversation');
  a.href = '#messages';
  a.onclick = (e) => { e.preventDefault(); $('messages')?.focus(); };
  document.body.insertBefore(a, document.body.firstChild);
}

// An icon-only button contains an SVG with no text, so a screen reader hears
// nothing at all without a label. ui.js does this for header buttons; nothing
// did it for the composer, the channel bar, the voice bar or the space rail.
function labelIconButtons(root = document) {
  if (!root?.querySelectorAll) return;
  const all = [...root.querySelectorAll('button.icon, button[data-ico], .rxn-add')];
  if (root.matches?.('button.icon, button[data-ico]')) all.push(root);
  for (const b of all) {
    if (b.getAttribute('aria-label')) continue;
    const t = (b.title || b.textContent || '').trim();
    if (t) b.setAttribute('aria-label', t);
  }
}

// ==========================================================================
// 7. ESCAPE CLOSED THE WRONG THING
//
// main.js binds Escape on window to closePopovers + closePanel. With a modal
// open that closed the modal AND the panel behind it, and nothing closed the
// long-press menu at all. A capture listener on window runs before every other
// keydown handler in the app, so it can settle the order without touching them.
// ==========================================================================
function wireEscape() {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const editing = document.querySelector('.ux-edit');
    if (editing) { e.stopPropagation(); cancelInlineEdit(editing); return; }
    const menu = document.querySelector('.ctxmenu');
    if (menu) { e.stopPropagation(); menu.remove(); return; }
    const back = [...document.querySelectorAll('.modal-back')].pop();
    if (back) {
      e.stopPropagation();
      back.querySelector('.modal-head button.icon')?.click();
    }
  }, true);
}

// ==========================================================================
// 8. ENTER IN THE EMAIL FIELD SENT A ONE-TIME CODE
//
// auth.js binds Enter on #email to sendCode(), while #email sits directly above
// #password and the Sign in button. On Android the on-screen keyboard shows
// "Go" on an email input, so somebody with a password types their address, taps
// Go, and gets an OTP mail they did not ask for with no explanation of what
// just happened.
//
// A capture listener on document runs before the target's own bubble listener,
// so stopping propagation there settles it without editing js/core/auth.js.
// ==========================================================================
function wireAuthEnter() {
  const email = $('email');
  if (email) {
    email.setAttribute('enterkeyhint', 'next');
    email.setAttribute('inputmode', 'email');
    email.setAttribute('autocapitalize', 'off');
  }
  $('password')?.setAttribute('enterkeyhint', 'go');
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target?.id !== 'email') return;
    e.preventDefault();
    e.stopPropagation();
    $('password')?.focus();
  }, true);
}

// ==========================================================================
// 9. INLINE EDIT
//
// Editing opened a modal over the conversation, with an empty label above the
// box, no mention autocomplete, no emoji picker and no attachments. Slack,
// Discord and Linear all edit in place, and in place is the only version that
// keeps the message you are correcting visible while you correct it.
//
// Bound to double-click and to the E key on a focused row rather than a new
// button, because the desktop action bar is already too wide.
// ==========================================================================
// `restore` puts the message back exactly as it was, which is right after a
// cancel and WRONG after a save: the snapshot is the text the author just
// replaced. It used to run on both paths, so a successful edit repainted the old
// wording over the new one and only came right if the realtime broadcast
// happened to land afterwards - which on a slow connection it does not. The edit
// looked like it had silently failed.
function closeInlineEdit(box, { restore = true, text = null } = {}) {
  const row = box.closest('.msg');
  const html = box.dataset.uxHtml;
  const target = row?.querySelector('.body');
  box.remove();
  if (target) {
    if (restore && html != null) target.innerHTML = html;
    target.style.display = '';
  }
  // Paint the new text ourselves through core's own renderer, so it is escaped
  // and formatted the same way and carries the (edited) marker. The realtime
  // event that follows runs the identical function, so this is idempotent.
  if (!restore && text != null && row?.dataset.id) applyEdit(row.dataset.id, text);
  row?.focus?.();
}

const cancelInlineEdit = (box) => closeInlineEdit(box, { restore: true });

function startInlineEdit(row, api) {
  if (!row || row.querySelector('.ux-edit')) return;
  const id = row.dataset.id;
  const m = store.msgCache.get(id);
  if (!m || m.author_id !== store.me) return;
  const bodyEl = row.querySelector('.body');
  if (!bodyEl) return;

  const box = el('div', 'ux-edit');
  box.dataset.uxHtml = bodyEl.innerHTML;
  const ta = el('textarea');
  ta.value = m.body_text || '';
  ta.setAttribute('aria-label', 'Edit your message');
  const hint = el('div', 'ux-edit-hint', 'Enter to save, Escape to cancel');
  box.append(ta, hint);
  bodyEl.style.display = 'none';
  bodyEl.after(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const save = async () => {
    const text = ta.value.trim();
    if (!text || text === m.body_text) { cancelInlineEdit(box); return; }
    ta.disabled = true;
    hint.textContent = 'Saving…';
    try {
      await api.edit(id, text);
      closeInlineEdit(box, { restore: false, text });
    } catch (e) {
      ta.disabled = false;
      ta.focus();
      // The text the author typed is still in the box, so nothing is lost and
      // Enter tries again. That is the whole contract on a bad connection.
      hint.textContent = humanError(e.message);
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
  });
}

function wireInlineEdit(api) {
  const list = $('messages');
  if (!list || list.dataset.uxEdit) return;
  list.dataset.uxEdit = '1';
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest?.('.msg');
    if (!row || e.target.closest('a,img,video,button,pre,code')) return;
    if (store.msgCache.get(row.dataset.id)?.author_id !== store.me) return;
    startInlineEdit(row, api);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'e' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const row = document.activeElement?.closest?.('.msg');
    if (!row) return;
    e.preventDefault();
    startInlineEdit(row, api);
  });
}

// ==========================================================================
// 10. COMPOSER FORMATTING
//
// The product renders markdown and syntax-highlights code, and had no
// formatting affordance whatsoever: Ctrl+B over a selection did nothing, and
// the only way to get bold was to know that ** means bold. On an explicitly
// non-technical audience that is the same as not having it at all.
// ==========================================================================
// icons.js has no list glyph and belongs to another agent, so this one is drawn
// here. Same 24-grid, same stroke weight, same currentColor as the rest.
const LIST_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<circle cx="5" cy="7" r="1.5" fill="currentColor"/>'
  + '<circle cx="5" cy="12" r="1.5" fill="currentColor"/>'
  + '<circle cx="5" cy="17" r="1.5" fill="currentColor"/>'
  + '<path d="M10 7h9M10 12h9M10 17h9" fill="none" stroke="currentColor" '
  + 'stroke-width="1.75" stroke-linecap="round"/></svg>';

function wrapSelection(open, close, placeholder) {
  const c = $('composer');
  if (!c) return;
  const s = c.selectionStart, e = c.selectionEnd;
  const sel = c.value.slice(s, e) || placeholder;
  c.value = c.value.slice(0, s) + open + sel + close + c.value.slice(e);
  c.focus();
  c.setSelectionRange(s + open.length, s + open.length + sel.length);
  c.dispatchEvent(new Event('input', { bubbles: true }));
}

function prefixLines(token) {
  const c = $('composer');
  if (!c) return;
  const s = c.selectionStart, e = c.selectionEnd;
  const start = c.value.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
  const nl = c.value.indexOf('\n', e);
  const end = nl === -1 ? c.value.length : nl;
  const block = c.value.slice(start, end) || 'item';
  let i = 0;
  const out = block.split('\n').map((l) => (token === '1. ' ? `${++i}. ` : token) + l).join('\n');
  c.value = c.value.slice(0, start) + out + c.value.slice(end);
  c.focus();
  c.setSelectionRange(start, start + out.length);
  c.dispatchEvent(new Event('input', { bubbles: true }));
}

async function insertLink(ui) {
  const c = $('composer');
  if (!c) return;
  const s = c.selectionStart, e = c.selectionEnd;
  const sel = c.value.slice(s, e);
  const out = await ui.formModal({
    title: 'Add a link',
    fields: [
      { name: 'text', label: 'Words people will see', value: sel, required: true },
      { name: 'url', label: 'Web address', placeholder: 'https://', required: true },
    ],
    submitLabel: 'Insert',
  });
  if (!out) return;
  c.value = `${c.value.slice(0, s)}[${out.text}](${out.url})${c.value.slice(e)}`;
  c.focus();
  c.dispatchEvent(new Event('input', { bubbles: true }));
}

function registerComposerTools(ui) {
  const wide = () => !isTouch();
  ui.addComposerButton({ id: 'ux-bold', order: 5, label: '<span class="ux-fmt-b">B</span>',
    title: 'Bold (Ctrl+B)', onClick: () => wrapSelection('**', '**', 'bold text') });
  ui.addComposerButton({ id: 'ux-italic', order: 6, label: '<span class="ux-fmt-i">i</span>',
    title: 'Italic (Ctrl+I)', onClick: () => wrapSelection('_', '_', 'italic text'), show: wide });
  ui.addComposerButton({ id: 'ux-link', order: 7, label: icon('link'),
    title: 'Add a link (Ctrl+K)', onClick: () => insertLink(ui) });
  ui.addComposerButton({ id: 'ux-list', order: 8, label: LIST_ICON,
    title: 'Bulleted list', onClick: () => prefixLines('- '), show: wide });
  ui.addComposerButton({ id: 'ux-quote', order: 9, label: '<span class="ux-fmt-q">&rdquo;</span>',
    title: 'Quote', onClick: () => prefixLines('> '), show: wide });
  ui.renderComposerButtons();

  const c = $('composer');
  if (!c || c.dataset.uxFmt) return;
  c.dataset.uxFmt = '1';
  c.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); wrapSelection('**', '**', 'bold text'); }
    else if (k === 'i') { e.preventDefault(); wrapSelection('_', '_', 'italic text'); }
    else if (k === 'k' && c.selectionStart !== c.selectionEnd) { e.preventDefault(); insertLink(ui); }
  });
  // Pasting a URL over a selection links the selection, which is what every
  // editor this audience has used already does.
  c.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text/plain')?.trim();
    if (!t || !/^https?:\/\/\S+$/i.test(t)) return;
    if (c.selectionStart === c.selectionEnd) return;
    e.preventDefault();
    e.stopPropagation();
    const s = c.selectionStart, en = c.selectionEnd;
    const sel = c.value.slice(s, en);
    c.value = `${c.value.slice(0, s)}[${sel}](${t})${c.value.slice(en)}`;
    const caret = s + sel.length + t.length + 4;
    c.setSelectionRange(caret, caret);
    c.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);
}

// ==========================================================================
// 11. EMPTY STATES
//
// The good ones in this app - Activity, Threads, the admin permission notice -
// are all the same three-part unit: what this is, how to fill it, and a way to
// do it. The bad ones told a phone user to "hover any message", or opened on
// search-operator syntax as the very first thing a non-technical volunteer sees.
// ==========================================================================
function threePartEmpty({ what, how, action, onAction, ico }) {
  const box = el('div', 'empty ux-empty');
  if (ico) box.insertAdjacentHTML('beforeend', icon(ico));
  box.appendChild(el('div', 'empty-title', esc(what)));
  if (how) box.appendChild(el('div', 'ux-empty-how', esc(how)));
  if (action) {
    const b = el('button', 'sm', esc(action));
    b.onclick = onAction;
    box.appendChild(b);
  }
  return box;
}

// ==========================================================================
// 12. THE MEMBERS PANEL
//
// Measured on a seeded workspace: 614 rows, 2460 DOM nodes and 24,728px of
// scroll content built eagerly on open and rebuilt in full on every keystroke.
// Four different people all rendered as "Revlw96" with no handle and nothing
// else to tell them apart, so "who do I ask for access" was unanswerable, and
// name collisions - guaranteed in an NGO full of volunteers who share a first
// name - were indistinguishable.
//
// registerPanel overwrites by id, so this replaces the core panel without
// editing js/core/actions.js.
// ==========================================================================
const RANK = { Owner: 0, Admin: 1, Moderator: 2, Member: 3 };
const ADMINISTRATOR = 1n << 40n;

// Three table reads, one of which is every member row in the Space, on every
// open of the panel. Cached per Space: role assignments change a handful of
// times a year and the panel gets opened several times a day, on somebody's own
// mobile data. A short life keeps a promotion from taking a reload to show up.
const ROLE_TTL = 5 * 60 * 1000;
let roleCache = { ws: null, at: 0, map: null };

async function memberRoleMap() {
  const out = new Map();
  if (!store.ws) return { roles: out, complete: false };
  if (roleCache.ws === store.ws.id && Date.now() - roleCache.at < ROLE_TTL && roleCache.map) {
    return { roles: roleCache.map, complete: true };
  }
  let got = false;
  try {
    const [members, links, roles] = await Promise.all([
      table('workspace_members', (q) => q.eq('workspace_id', store.ws.id)),
      table('member_roles', (q) => q.eq('workspace_id', store.ws.id)),
      table('roles', (q) => q.eq('workspace_id', store.ws.id)),
    ]);
    // A Space always has at least one member row, so an empty answer means the
    // read failed - offline, most likely. Do not cache that for five minutes.
    // PostgREST stops at 1000 rows, and a truncated membership list must NOT be
    // used to filter the panel: leaving a real colleague out of "Members" is a
    // worse answer than leaving a stranger in. Two NGOs will never reach this,
    // but the failure mode if they did would be silent and confusing.
    got = members.length > 0 && members.length < 1000;
    const byRole = new Map(roles.map((r) => [r.id, r]));
    for (const m of members) {
      out.set(m.user_id, m.member_type === 'moderator' ? 'Moderator' : 'Member');
    }
    for (const l of links) {
      const r = byRole.get(l.role_id);
      if (!r || r.is_everyone) continue;
      // Whatever the role is called locally, holding ADMINISTRATOR makes you one.
      let admin = false;
      try { admin = (BigInt(r.permissions || 0) & ADMINISTRATOR) !== 0n; } catch { admin = false; }
      if (admin) out.set(l.user_id, 'Admin');
    }
    // public.workspaces has no owner_id - the column is created_by. Reading a
    // name that is not there meant the Owner pill never rendered once, which is
    // the single label the panel exists to show: an ordinary member cannot read
    // member_roles at all (RLS), so without this nobody in the list is marked.
    const owner = store.ws.created_by || store.ws.owner_id;
    if (owner) out.set(owner, 'Owner');
  } catch { /* roles are a nicety; the list still has to render */ }
  if (got) roleCache = { ws: store.ws.id, at: Date.now(), map: out };
  return { roles: out, complete: got };
}

function registerMembersPanel(ui) {
  ui.registerPanel({
    id: 'members',
    title: 'Members',
    async render(body) {
      body.innerHTML = panelSkeleton();
      const { roles, complete } = await memberRoleMap();
      // store.profiles is a global cache of everyone this session has ever seen
      // - across every Space, every DM and every search result. Listing it under
      // the heading "Members" was wrong: measured on a seeded workspace it
      // showed 1237 people for a Space with 1000 members. Filter to the actual
      // membership when we could read it, and fall back to the cache when we
      // could not, because a list that is slightly too long beats an empty panel.
      const all = complete
        ? [...store.profiles.values()].filter((p) => roles.has(p.id))
        : [...store.profiles.values()];

      body.innerHTML = '';
      const search = el('input');
      search.type = 'search';
      search.placeholder = 'Search members';
      search.setAttribute('aria-label', 'Search members');
      const list = el('div', 'ux-memlist');
      body.append(search, list);

      let showAll = false;
      const CAP = 50;

      const row = (p) => {
        const r = el('div', 'member');
        r.tabIndex = 0;
        const role = roles.get(p.id);
        const name = p.display_name || p.username || 'user';
        // A handle under every name. Four people called Revlw96 was the actual
        // measured state of the panel.
        const sub = p.username ? '@' + p.username
          : plain(p.status_text || '', 40) || 'no handle yet';
        r.innerHTML = `${avatarHtml(p.id, 28)}
          <div class="ux-mem-name">
            <span class="truncate">${esc(name)}${p.status_emoji ? ` <span>${esc(p.status_emoji)}</span>` : ''}</span>
            <span class="ux-mem-handle">${esc(sub)}</span>
          </div>
          ${role && role !== 'Member' ? `<span class="ux-rolepill">${esc(role)}</span>` : ''}
          <span class="dot ${store.online.has(p.id) ? 'on' : 'off'}"></span>`;
        const open = (ev) => bus.emit('profile:open', { userId: p.id, anchor: r, ev });
        r.onclick = open;
        r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } };
        return r;
      };

      const draw = () => {
        const q = search.value.trim().toLowerCase();
        list.innerHTML = '';
        const hit = all.filter((p) => !q ||
          (p.display_name || '').toLowerCase().includes(q) ||
          (p.username || '').toLowerCase().includes(q));

        if (!hit.length) {
          list.appendChild(threePartEmpty({
            what: q ? `Nobody here matches "${q}".` : 'Nobody has joined yet.',
            how: q ? 'Try part of a first name, or their @handle.'
              : 'Use Invite in the channel bar to send someone a link.',
          }));
          return;
        }

        const byRole = (a, b) =>
          (RANK[roles.get(a.id)] ?? 3) - (RANK[roles.get(b.id)] ?? 3) ||
          (a.display_name || '').localeCompare(b.display_name || '');
        const online = hit.filter((p) => store.online.has(p.id)).sort(byRole);
        const offline = hit.filter((p) => !store.online.has(p.id)).sort(byRole);

        const section = (title, arr, cap) => {
          if (!arr.length) return;
          list.appendChild(el('h4', 'sec', `${esc(title)} - ${arr.length}`));
          const shown = cap == null ? arr : arr.slice(0, cap);
          for (const p of shown) list.appendChild(row(p));
          if (shown.length < arr.length) {
            const b = el('button', 'ux-more-row', `Show the other ${arr.length - shown.length}`);
            b.onclick = () => { showAll = true; draw(); };
            list.appendChild(b);
          }
        };
        // Online is the list people scan. Offline is capped because six hundred
        // rows janks a low-end Android on open and again on every keystroke.
        section('Online', online, null);
        section('Offline', offline, showAll || q ? null : CAP);
      };

      // 150ms is under the threshold where typing feels laggy and well over the
      // rate a phone keyboard fires at.
      search.addEventListener('input', debounce(draw, 150));
      draw();
      setTimeout(() => search.focus(), 30);
    },
  });
}

// ==========================================================================
// 13. THE SEARCH PANEL
//
// It opened on `Try from:@name in:#channel has:link before:2026-01-01` - query
// operators as the first thing a non-technical user sees - with no recent
// searches and no way to search the channel they were already reading.
// ==========================================================================
const RECENT_KEY = 'hearth.ux.recentSearch';
const recentSearches = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
};
const rememberSearch = (q) => {
  try {
    localStorage.setItem(RECENT_KEY,
      JSON.stringify([q, ...recentSearches().filter((x) => x !== q)].slice(0, 6)));
  } catch { /* private mode */ }
};

// Same grammar as the core parser; duplicated rather than imported because
// js/core/actions.js does not export it.
function parseSearch(raw) {
  const o = { query: '', channel: null, fromUser: null, has: null, before: null, after: null };
  const rest = [];
  for (const tok of raw.split(/\s+/)) {
    const m = tok.match(/^(from|in|has|before|after):(.+)$/i);
    if (!m) { rest.push(tok); continue; }
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'in') {
      const ch = store.channels.find((c) => c.name === v.replace(/^#/, ''));
      if (ch) o.channel = ch.id;
    } else if (k === 'from') {
      const p = [...store.profiles.values()].find((x) =>
        (x.username || '').toLowerCase() === v.replace(/^@/, '').toLowerCase() ||
        (x.display_name || '').toLowerCase() === v.replace(/^@/, '').toLowerCase());
      if (p) o.fromUser = p.id;
    } else if (k === 'has') o.has = v;
    else if (k === 'before') o.before = new Date(v).toISOString();
    else if (k === 'after') o.after = new Date(v).toISOString();
  }
  o.query = rest.join(' ').trim();
  return o;
}

function registerSearchPanel(ui, api) {
  ui.registerPanel({
    id: 'search',
    title: 'Search',
    async render(body, ctx) {
      body.innerHTML = '';
      const input = el('input');
      input.id = 'searchInput';       // the id the rest of the app and the
      input.type = 'search';          // smoke suite have always looked for;
      input.placeholder = 'Search messages';   // this panel replaces the core
      input.value = ctx.q || '';      // one, so it has to keep the handle.
      input.setAttribute('aria-label', 'Search messages');
      const boxEl = el('div', 'search-box');
      boxEl.appendChild(input);
      const results = el('div');
      results.id = 'searchResults';
      body.append(boxEl, results);

      const start = () => {
        results.innerHTML = '';
        const recent = recentSearches();
        if (recent.length) {
          results.appendChild(el('h4', 'sec', 'Recent'));
          const chips = el('div', 'ux-chips');
          for (const q of recent) {
            const c = el('button', 'ux-chip', esc(q));
            c.onclick = () => { input.value = q; run(); };
            chips.appendChild(c);
          }
          results.appendChild(chips);
        }
        results.appendChild(threePartEmpty({
          what: 'Find any message in this Space.',
          how: 'Type a word or two. Search looks at every channel you can see.',
        }));
        if (store.current) {
          const chips = el('div', 'ux-chips');
          const c = el('button', 'ux-chip', `Search only in #${esc(store.current.name)}`);
          c.onclick = () => {
            input.value = `in:#${store.current.name} ${input.value}`.trim();
            input.focus();
          };
          chips.appendChild(c);
          results.appendChild(chips);
        }
        // The operator sheet is useful and it is not what somebody needs to see
        // before they have typed a single character.
        const tips = el('details', 'ux-tips');
        tips.innerHTML = `<summary>Search tips</summary>
          <p><code>from:@name</code> only that person &middot;
             <code>in:#channel</code> only that channel &middot;
             <code>has:link</code> messages with a link &middot;
             <code>before:2026-01-01</code></p>`;
        results.appendChild(tips);
      };

      const run = async () => {
        const raw = input.value.trim();
        if (!raw) { start(); return; }
        rememberSearch(raw);
        results.innerHTML = panelSkeleton();
        try {
          const rows = await api.search({ ...parseSearch(raw), workspace: store.ws.id, limit: 40 });
          results.innerHTML = '';
          if (!rows?.length) {
            results.appendChild(threePartEmpty({
              what: `Nothing matches "${raw}".`,
              how: 'Try one distinctive word on its own. Search does not match parts of words.',
            }));
            return;
          }
          for (const r of rows) {
            const ch = store.channels.find((c) => c.id === r.channel_id);
            const card = el('div', 'result');
            card.tabIndex = 0;
            card.innerHTML = `<div class="muted">${esc(nameOf(r.author_id))}
              in #${esc(ch?.name || '?')} &middot; ${esc(relTime(r.created_at))}</div>
              <div class="body">${esc(plain(r.body_text, 200))}</div>`;
            const go = () => { if (ch) openChannel(ch, { keepPanel: true, jumpSeq: r.seq }); };
            card.onclick = go;
            card.onkeydown = (e) => { if (e.key === 'Enter') go(); };
            results.appendChild(card);
          }
        } catch (e) {
          results.innerHTML = '';
          results.appendChild(threePartEmpty({
            what: humanError(e.message),
            how: 'Search needs a connection. Nothing you have written is affected.',
            action: 'Try again', onAction: run,
          }));
        }
      };

      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
      setTimeout(() => input.focus(), 30);
      if (ctx.q) run(); else start();
    },
  });
}

// ==========================================================================
// 14. THE SPACE RAIL ON A PHONE
//
// 60px of a 390px screen - roughly 15% - held permanently for a column with one
// icon in it. Most volunteers belong to exactly one organisation.
// ==========================================================================
function trackSpaceCount() {
  const set = () => document.body.classList.toggle('ux-one-space', (store.spaces || []).length <= 1);
  set();
  bus.on('workspace', set);
  bus.on('spaces:badges', set);
  setTimeout(set, 1500);
}

// ==========================================================================
export function register(app) {
  const { ui, api } = app;
  UI = ui;

  wireEscape();
  wireAuthEnter();
  wireBodyAdditions();

  // Split in two: the observers and the bus subscriptions must be installed
  // exactly once, or switching Space stacks a second copy of every one of them.
  let installed = false;
  const boot = () => {
    try {
      if (!installed) {
        installed = true;
        addSkipLink();
        watchLoading();
        wireMessageList();
        wireInlineEdit(api);
        trackSpaceCount();
      }
      wireChannelList();
      labelIconButtons();
      paintUnreadPill();
    } catch { /* a partial fix is better than a dead app */ }
  };

  // The shell exists at import time; the channel list and the message list are
  // only populated once a workspace is open.
  bus.on('workspace', () => setTimeout(boot, 0));
  bus.on('channels', () => setTimeout(() => { wireChannelList(); labelIconButtons(); }, 0));
  bus.on('channel:open', ({ channel }) => {
    armUnreadJump(channel?.id);
    setTimeout(labelIconButtons, 0);
  });
  bus.on('dm:open', () => armUnreadJump(null));
  bus.on('message:render', debounce(tryUnreadJump, 140));

  registerComposerTools(ui);
  registerMembersPanel(ui);
  registerSearchPanel(ui, api);

  boot();
}
