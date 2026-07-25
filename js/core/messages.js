// Message rendering: grouping, day dividers, the hover action bar, reactions,
// quotes and attachments. Everything that draws a message lives here so threads,
// DMs, search results and pins all look identical.
import { sb } from '../sb.js';
import { api } from '../api.js';
import { store, bus, nameOf, profileOf } from '../store.js';
import { $, el, esc, fmt, timeOf, dayOf, plain, hueOf, initials } from '../util.js';
import { QUICK_EMOJI } from '../config.js';
import { getMessageActions, toast, contextMenu } from '../ui.js';
import { attsHtml, hydrateMedia } from './media.js';
import { openEmojiPicker } from './emoji.js';
import { icon } from '../icons.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function avatarHtml(userId, size = 36) {
  const p = profileOf(userId);
  const name = p?.display_name || p?.username || '?';
  const h = hueOf(userId || name);
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:hsl(${h} 45% 32%)"
    title="${esc(name)}" data-user="${esc(userId || '')}">${esc(initials(name))}</div>`;
}

function mentionsMe(m) {
  if (Array.isArray(m.mention_user_ids) && m.mention_user_ids.includes(store.me)) return true;
  return m.mention_scope === 'here' || m.mention_scope === 'channel';
}

function fmtOpts() {
  const meNames = new Set();
  const p = store.myProfile;
  if (p?.username) meNames.add(p.username.toLowerCase());
  if (p?.display_name) meNames.add(p.display_name.toLowerCase());
  return { channels: store.channels, meNames };
}

// Build one message row. `opts.context` is 'channel' | 'thread' | 'dm' | 'static'
// and decides which actions are offered.
export function buildMessage(m, opts = {}) {
  const context = opts.context || 'channel';
  const mine = m.author_id === store.me;
  const row = el('div', 'msg');
  row.dataset.id = m.id || '';
  row.dataset.seq = m.seq ?? '';
  row.dataset.author = m.author_id || '';
  if (m.id) row.id = 'm' + m.id;
  if (mine) row.classList.add('me');
  if (mentionsMe(m)) row.classList.add('mention');
  if (m.priority === 'urgent') row.classList.add('urgent');
  if (opts.grouped) row.classList.add('grouped');

  const th = m.id ? store.rootThreads.get(m.id) : null;
  const who = nameOf(m.author_id);
  const isBot = !!m.bot_id || !!m.webhook_id;

  row.innerHTML = `
    ${opts.grouped ? `<div class="gutter"><span class="ghost-time">${timeOf(m.created_at)}</span></div>`
      : `<div class="gutter">${avatarHtml(m.author_id)}</div>`}
    <div class="mbody">
      ${opts.grouped ? '' : `<div class="mhead">
        <span class="who" data-user="${esc(m.author_id || '')}">${esc(who)}</span>
        ${isBot ? '<span class="pill pill-bot">APP</span>' : ''}
        ${m.priority === 'urgent' ? '<span class="pill pill-urgent">URGENT</span>' : ''}
        ${m.topic ? `<span class="pill pill-topic" data-topic="${esc(m.topic)}">${esc(m.topic)}</span>` : ''}
        <span class="t">${timeOf(m.created_at)}</span>
      </div>`}
      ${m.reply_to_id ? `<div class="quote" data-q="${esc(m.reply_to_id)}">↩ …</div>` : ''}
      ${m.also_send_to_channel && m.thread_id
        ? '<div class="thread-origin">↳ also sent to the channel from a thread</div>' : ''}
      <div class="body">${fmt(m.body_text, fmtOpts())}${m.edited_at ? ' <span class="edited">(edited)</span>' : ''}</div>
      ${attsHtml(m)}
      <div class="rxns" data-rx="${esc(m.id || '')}"></div>
      <div class="threadind" data-th="${esc(m.id || '')}" style="${th ? '' : 'display:none'}"></div>
    </div>
    <div class="actions"></div>`;

  // ---- hover action bar: quick reactions + registered actions ----
  if (context !== 'static' && m.id) {
    const bar = row.querySelector('.actions');
    for (const e of QUICK_EMOJI) {
      const b = el('button', 'icon quick', e);
      b.title = 'React ' + e;
      b.onclick = () => toggleReaction(m.id, e);
      bar.appendChild(b);
    }
    const more = el('button', 'icon', icon('smile'));
    more.title = 'Pick a reaction';
    more.onclick = () => openEmojiPicker(more, (ch) => toggleReaction(m.id, ch));
    bar.appendChild(more);

    for (const a of getMessageActions({ ...m, _context: context })) {
      if (a.contexts && !a.contexts.includes(context)) continue;
      const b = el('button', 'icon', a.label);
      b.title = a.title || a.label;
      b.onclick = (ev) => a.onClick(m, ev, row);
      bar.appendChild(b);
    }
    row.oncontextmenu = (ev) => {
      if (ev.target.closest('a,img,video,input,textarea')) return;
      ev.preventDefault();
      contextMenu(ev, getMessageActions({ ...m, _context: context })
        .filter((a) => !a.contexts || a.contexts.includes(context))
        .map((a) => ({ label: `${a.label}  ${a.title || ''}`.trim(), danger: a.danger, onClick: () => a.onClick(m, ev, row) })));
    };
  }

  // ---- thread indicator ----
  const ti = row.querySelector('[data-th]');
  if (ti) {
    if (th) paintThreadIndicator(ti, th);
    ti.onclick = () => bus.emit('thread:request', { message: m });
  }

  if (Array.isArray(m.attachments) && m.attachments.length) hydrateMedia(row);
  if (m.reply_to_id) fillQuote(row, m.reply_to_id);
  if (m.id) {
    store.msgCache.set(m.id, m);
    paintReactions(m.id);
  }

  row.querySelectorAll('[data-user]').forEach((n) => {
    n.onclick = (ev) => { ev.stopPropagation(); bus.emit('profile:open', { userId: n.dataset.user, anchor: n }); };
  });
  row.querySelectorAll('.chanlink').forEach((n) => {
    n.onclick = () => bus.emit('channel:request', { channelId: n.dataset.chan });
  });

  bus.emit('message:render', { msg: m, el: row, context });
  return row;
}

function paintThreadIndicator(node, th) {
  node.style.display = '';
  const n = th.count || 0;
  node.innerHTML = `<span class="th-dot"></span>${n} ${n === 1 ? 'reply' : 'replies'}
    ${th.last_message_at ? `<span class="muted"> · ${timeOf(th.last_message_at)}</span>` : ''}
    <span class="th-open">View thread</span>`;
}

export function refreshThreadIndicator(rootMessageId) {
  const t = store.rootThreads.get(rootMessageId);
  const node = document.querySelector(`[data-th="${CSS.escape(rootMessageId)}"]`);
  if (node && t) paintThreadIndicator(node, t);
}

async function fillQuote(row, replyToId) {
  const node = row.querySelector(`[data-q="${CSS.escape(replyToId)}"]`);
  if (!node) return;
  let ref = store.msgCache.get(replyToId);
  if (!ref) {
    const { data } = await sb.from('messages')
      .select('id,author_id,body_text,attachments').eq('id', replyToId).maybeSingle();
    if (data) { ref = data; store.msgCache.set(replyToId, data); }
  }
  if (!ref) { node.innerHTML = '↩ <span class="muted">original message unavailable</span>'; return; }
  const hasAtt = Array.isArray(ref.attachments) && ref.attachments.length;
  node.innerHTML = `↩ ${avatarHtml(ref.author_id, 16)} <b>${esc(nameOf(ref.author_id))}</b>
    <span>${esc(plain(ref.body_text, 90)) || (hasAtt ? '[attachment]' : '')}</span>`;
  node.onclick = () => jumpTo(replyToId);
}

export function jumpTo(messageId) {
  const node = document.getElementById('m' + messageId);
  if (!node) { bus.emit('message:jump', { messageId }); return; }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
}

export function scrollDown() {
  const m = $('messages');
  if (m) m.scrollTop = m.scrollHeight;
}

// ------------------------------------------------------------------ list append
// Appends into `host`, deciding grouping and day dividers from the previous row.
// `opts.replacing` swaps an existing row (the optimistic one) for a freshly
// built row. Grouping is decided from the neighbour ABOVE that row rather than
// from the end of the list, and the new node is inserted before the old one is
// removed, so there is never an instant where the message is missing from the
// DOM - a remove-then-append leaves a gap that anything holding a reference
// (a hover, a scroll, a test) trips over.
export function appendMessage(host, m, context = 'channel', opts = {}) {
  const anchor = opts.replacing || null;
  const last = anchor ? anchor.previousElementSibling : host.lastElementChild;
  const lastAuthor = last?.dataset?.author;
  const lastTime = last?.dataset?.time ? +last.dataset.time : 0;
  const t = new Date(m.created_at || Date.now()).getTime();

  const lastDay = last?.dataset?.day;
  const day = dayOf(m.created_at || Date.now());
  if (day !== lastDay && !anchor) {
    const d = el('div', 'daydiv', `<span>${esc(day)}</span>`);
    d.dataset.day = day;
    host.appendChild(d);
  }

  const grouped = !!last && last.classList.contains('msg') &&
    lastAuthor === m.author_id && t - lastTime < GROUP_WINDOW_MS &&
    !m.reply_to_id && day === lastDay;

  const row = buildMessage(m, { context, grouped });
  row.dataset.time = t;
  row.dataset.day = day;
  if (anchor) {
    anchor.parentNode.insertBefore(row, anchor);
    anchor.remove();
  } else {
    host.appendChild(row);
  }
  return row;
}

// Promote an optimistic row to a real one WITHOUT replacing the node.
//
// The optimistic row is rendered against a temporary id (the send nonce), so its
// reaction target, thread target and action handlers all point at something the
// server has never heard of. Swapping in a freshly built row fixes that but
// destroys and recreates the element, and anything holding a reference to it -
// a hover, a scroll anchor, a pointer already pressed - is left pointing at a
// detached node. Rebinding in place keeps one stable element for the lifetime of
// the message.
export function upgradeMessageRow(row, m, context = 'channel') {
  if (!row || !m?.id) return row;
  row.id = 'm' + m.id;
  row.dataset.id = m.id;
  row.dataset.seq = m.seq ?? '';
  row.classList.remove('pending');

  row.querySelector('[data-rx]')?.setAttribute('data-rx', m.id);
  row.querySelector('[data-th]')?.setAttribute('data-th', m.id);

  const bar = row.querySelector('.actions');
  if (bar && context !== 'static') {
    bar.innerHTML = '';
    for (const e of QUICK_EMOJI) {
      const b = el('button', 'icon quick', e);
      b.title = 'React ' + e;
      b.onclick = () => toggleReaction(m.id, e);
      bar.appendChild(b);
    }
    const more = el('button', 'icon', icon('smile'));
    more.title = 'Pick a reaction';
    more.onclick = () => openEmojiPicker(more, (ch) => toggleReaction(m.id, ch));
    bar.appendChild(more);
    for (const a of getMessageActions({ ...m, _context: context })) {
      if (a.contexts && !a.contexts.includes(context)) continue;
      const b = el('button', 'icon', a.label);
      b.title = a.title || a.label;
      b.onclick = (ev) => a.onClick(m, ev, row);
      bar.appendChild(b);
    }
  }

  const ti = row.querySelector('[data-th]');
  if (ti) ti.onclick = () => bus.emit('thread:request', { message: m });

  store.msgCache.set(m.id, m);
  paintReactions(m.id);
  return row;
}

// Is this message already on screen INSIDE this particular container?
//
// claimMessage() is a single global gate: one message, one render. That holds
// everywhere except a thread reply sent with "Also send to channel", which
// legitimately belongs in TWO places at once - the thread panel and the channel.
// With one shared gate whichever path ran first consumed the claim and the other
// silently rendered nothing. Containers arbitrate for themselves.
export function renderedIn(host, messageId) {
  if (!host || !messageId) return false;
  return !!host.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
}

// Dedupe gate: returns false when this message was already rendered (by id or by
// the optimistic-send nonce).
export function claimMessage(m) {
  const nonce = m.client_msg_id;
  if (nonce && store.seen.has('n:' + nonce)) {
    const ex = document.getElementById('m' + nonce);
    if (ex && m.id) { ex.id = 'm' + m.id; ex.dataset.id = m.id; ex.classList.remove('pending'); }
    if (m.id) { store.seen.add(m.id); store.msgCache.set(m.id, m); }
    return false;
  }
  if (m.id && store.seen.has(m.id)) return false;
  if (m.id) store.seen.add(m.id);
  if (nonce) store.seen.add('n:' + nonce);
  return true;
}

// ------------------------------------------------------------------ reactions
export function paintReactions(messageId) {
  const host = document.querySelector(`[data-rx="${CSS.escape(messageId)}"]`);
  if (!host) return;
  const em = store.rxn.get(messageId);
  if (!em || !em.size) { host.innerHTML = ''; return; }
  let h = '';
  for (const [emoji, users] of em) {
    if (!users.size) continue;
    const mine = users.has(store.me);
    const names = [...users].slice(0, 8).map(nameOf).join(', ');
    h += `<button class="rxn${mine ? ' mine' : ''}" data-e="${esc(emoji)}"
      title="${esc(names)}${users.size > 8 ? ' and more' : ''}">${esc(emoji)} <b>${users.size}</b></button>`;
  }
  h += '<button class="rxn rxn-add" data-add="1" title="Add reaction">＋</button>';
  host.innerHTML = h;
  host.querySelectorAll('.rxn[data-e]').forEach((b) => {
    b.onclick = () => toggleReaction(messageId, b.dataset.e);
  });
  const add = host.querySelector('[data-add]');
  if (add) add.onclick = () => openEmojiPicker(add, (ch) => toggleReaction(messageId, ch));
}

export function applyReaction({ message_id, emoji, user_id, added }) {
  if (!store.rxn.has(message_id)) store.rxn.set(message_id, new Map());
  const em = store.rxn.get(message_id);
  if (!em.has(emoji)) em.set(emoji, new Set());
  if (added) em.get(emoji).add(user_id);
  else { em.get(emoji).delete(user_id); if (!em.get(emoji).size) em.delete(emoji); }
  paintReactions(message_id);
}

// Optimistic: paint immediately, persist after. The server broadcast reconciles
// everyone else, and the periodic refetch heals any missed broadcast.
export async function toggleReaction(messageId, emoji) {
  const em = store.rxn.get(messageId);
  const has = em?.get(emoji)?.has(store.me);
  applyReaction({ message_id: messageId, emoji, user_id: store.me, added: !has });
  try {
    await api.react(messageId, emoji);
  } catch (e) {
    applyReaction({ message_id: messageId, emoji, user_id: store.me, added: !!has });
    toast(e.message || 'Reaction failed', 'error');
  }
}

export async function loadReactions(ids) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) return;
  const { data } = await sb.from('message_reactions')
    .select('message_id,emoji,user_id').in('message_id', ids);
  const byMsg = new Map();
  for (const r of data || []) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, new Map());
    const em = byMsg.get(r.message_id);
    if (!em.has(r.emoji)) em.set(r.emoji, new Set());
    em.get(r.emoji).add(r.user_id);
  }
  for (const id of ids) {
    store.rxn.set(id, byMsg.get(id) || new Map());
    paintReactions(id);
  }
}

// ------------------------------------------------------------------ edit/delete
export function applyEdit(id, bodyText) {
  const row = document.getElementById('m' + id);
  if (!row) return;
  row.querySelector('.body').innerHTML =
    fmt(bodyText, fmtOpts()) + ' <span class="edited">(edited)</span>';
  const cached = store.msgCache.get(id);
  if (cached) store.msgCache.set(id, { ...cached, body_text: bodyText, edited_at: new Date().toISOString() });
}

export function applyDelete(id) {
  const row = document.getElementById('m' + id);
  if (!row) return;
  row.classList.add('deleted');
  row.querySelector('.body').innerHTML = '<span class="muted">message deleted</span>';
  row.querySelector('.atts')?.remove();
  row.querySelector('.actions')?.remove();
}
