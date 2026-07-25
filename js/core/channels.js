// Channel list (categories, text, voice, DMs) and the open-channel lifecycle:
// load a page, subscribe to realtime, page upward on scroll, reconcile any
// broadcast the at-most-once transport dropped.
import { sb, subscribe, unsubscribe } from '../sb.js';
import { api, table } from '../api.js';
import { store, bus, nameOf, resetChannelState, hasPerm } from '../store.js';
import { PERM, MESSAGE_PAGE } from '../config.js';
import { $, el, esc, debounce } from '../util.js';
import { toast, contextMenu, formModal, confirmModal, renderNavSections, closePanel } from '../ui.js';
import { appendMessage, claimMessage, loadReactions, applyEdit, applyDelete, applyReaction,
  refreshThreadIndicator, jumpTo, buildMessage, scrollDown, renderedIn,
  renderBatch, prependBatch, capWindow, capWindowTop, resetWindow, windowState,
  restoreAbove, restoreBelow, deferBelow, jumpLatest } from './messages.js';
import * as pagecache from '../lib/pagecache.js';

export { scrollDown };

let loadingOlder = false;

// ------------------------------------------------------------------ delivery state
// One channel open at a time, and every await inside openChannel() is a chance
// for the user to tap a different one. `openGen` is the token that says which
// open is still the real one: anything that resumes after a newer open started
// and finds its generation stale must drop what it was doing. Without it the
// SLOWER of two taps wins - it subscribes last and overwrites store.cursor -
// and the visible channel ends up joined to the wrong realtime topic with a
// cursor from the other channel, at which point neither the socket nor the
// resync can ever deliver a message into it again. Measured: 25s, nothing.
let openGen = 0;

// Telegram waits up to half a second before treating a hole as a gap, because
// the transport is allowed to reorder. Ours can too.
const GAP_GRACE_MS = 300;
const RESUME_PAGE = 200;         // events per resume() call
const RESUME_MAX_PAGES = 5;      // past ~1000 events behind, re-bootstrap instead
const MARK_READ_MS = 1200;

// Messages that arrived ahead of their turn, held until the log fills the hole
// beneath them. Keyed by seq.
const gapBuffer = new Map();
const GAP_BUFFER_MAX = 300;

// Observable delivery counters. The app could previously not answer "did I miss
// anything", which is the only question that matters here.
export const delivery = {
  gaps: 0,          // holes detected in the incoming seq stream
  healed: 0,        // events replayed out of the log
  resyncs: 0,       // resume passes run
  resnapshots: 0,   // times the cursor was too far behind to resume
  buffered: 0,      // messages currently held waiting for a gap to fill
  lastReason: null,
  lastAt: 0,
};

// ------------------------------------------------------------------ nav render
export async function renderChannels() {
  const host = $('channels');
  if (!host || !store.ws) return;
  const um = store.unread;
  const text = store.channels.filter((c) => c.kind !== 'voice' && !c.archived_at);
  const voice = store.channels.filter((c) => c.kind === 'voice' && !c.archived_at);

  const byCat = new Map();
  for (const c of text) {
    const k = c.category_id || '';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(c);
  }

  const chanRow = (c) => {
    const u = um.get(c.id);
    const unread = u?.unread > 0;
    const mc = u?.mention_count || 0;
    const muted = store.notify.get(c.id)?.notify_level === 'nothing';
    const icon = c.kind === 'announcement' ? '📢' : c.kind === 'forum' ? '🗂' : c.is_private ? '🔒' : '#';
    return `<div class="chan${store.current?.id === c.id ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted-ch' : ''}"
      data-ch="${c.id}"><span class="ch-ico">${icon}</span><span class="ch-name">${esc(c.name)}</span>
      ${mc ? `<span class="badge">${mc}</span>` : unread ? '<span class="dot-unread"></span>' : ''}</div>`;
  };

  let h = '';
  const uncat = byCat.get('') || [];
  if (uncat.length) h += `<div class="navgroup">${uncat.map(chanRow).join('')}</div>`;
  for (const cat of store.categories) {
    const list = byCat.get(cat.id) || [];
    if (!list.length) continue;
    const collapsed = localStorage.getItem('hearth.cat.' + cat.id) === '0';
    h += `<h3 data-cat="${cat.id}"><span>${collapsed ? '▸' : '▾'} ${esc(cat.name)}</span></h3>
      <div class="navgroup" ${collapsed ? 'style="display:none"' : ''}>${list.map(chanRow).join('')}</div>`;
  }
  if (hasPerm(PERM.MANAGE_CHANNELS)) h += '<div class="chan chan-add" data-newch="1">＋ Add channel</div>';

  if (voice.length) {
    h += '<h3><span>Voice</span></h3><div class="navgroup">';
    for (const c of voice) {
      const parts = store.voiceParts.get(c.id) || [];
      h += `<div class="chan vchan" data-voice="${c.id}"><span class="ch-ico">🔊</span>
        <span class="ch-name">${esc(c.name)}</span>${parts.length ? `<span class="live">${parts.length}</span>` : ''}</div>`;
      if (parts.length) {
        h += '<div class="vparts-nav">' + parts.map((u) =>
          `<span class="vpart-nav" data-vp="${esc(u)}">${esc(nameOf(u))}</span>`).join('') + '</div>';
      }
    }
    h += '</div>';
  }

  h += '<h3><span>Direct messages</span></h3><div class="navgroup">';
  for (const d of store.dms) {
    const others = (d.other_user_ids || []).filter((u) => u !== store.me);
    const label = others.length ? others.map(nameOf).join(', ') : 'you';
    const unread = d.unread > 0;
    h += `<div class="chan${store.currentDM === d.conversation_id ? ' active' : ''}${unread ? ' unread' : ''}"
      data-dm="${d.conversation_id}"><span class="ch-ico">@</span><span class="ch-name">${esc(label)}</span>
      ${unread ? `<span class="badge">${d.unread}</span>` : ''}</div>`;
  }
  h += '<div class="chan chan-add" data-newdm="1">＋ New message</div></div>';

  host.innerHTML = h;

  host.querySelectorAll('[data-ch]').forEach((n) => {
    n.onclick = () => openChannel(store.channels.find((c) => c.id === n.dataset.ch));
    n.oncontextmenu = (e) => { e.preventDefault(); channelMenu(e, store.channels.find((c) => c.id === n.dataset.ch)); };
  });
  host.querySelectorAll('[data-voice]').forEach((n) => {
    n.onclick = () => bus.emit('voice:join', { channelId: n.dataset.voice });
  });
  host.querySelectorAll('[data-dm]').forEach((n) => {
    n.onclick = () => bus.emit('dm:request', { conversationId: n.dataset.dm });
  });
  host.querySelector('[data-newdm]')?.addEventListener('click', () => bus.emit('dm:new'));
  host.querySelector('[data-newch]')?.addEventListener('click', createChannelDialog);
  host.querySelectorAll('h3[data-cat]').forEach((n) => {
    n.onclick = () => {
      const k = 'hearth.cat.' + n.dataset.cat;
      localStorage.setItem(k, localStorage.getItem(k) === '0' ? '1' : '0');
      renderChannels();
    };
  });

  await renderNavSections();
}

function channelMenu(ev, c) {
  if (!c) return;
  const muted = store.notify.get(c.id)?.notify_level === 'nothing';
  contextMenu(ev, [
    { label: muted ? 'Unmute channel' : 'Mute channel', onClick: () => toggleMute(c) },
    { label: 'Mark as read', onClick: () => api.markRead('channel', c.id, c.last_seq || 0).then(() => refreshUnread()) },
    { label: 'Copy link', onClick: () => {
      navigator.clipboard?.writeText(location.origin + location.pathname + '#/c/' + c.id);
      toast('Channel link copied');
    } },
    '-',
    { label: 'Edit channel', show: hasPerm(PERM.MANAGE_CHANNELS), onClick: () => editChannelDialog(c) },
    { label: 'Delete channel', danger: true, show: hasPerm(PERM.MANAGE_CHANNELS), onClick: async () => {
      if (!(await confirmModal({ title: 'Delete #' + c.name, body: 'Every message in it goes too. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
      try { await api.deleteChannel(c.id); toast('Channel deleted'); bus.emit('channels:reload'); }
      catch (e) { toast(e.message, 'error'); }
    } },
  ]);
}

export async function toggleMute(c) {
  const muted = store.notify.get(c.id)?.notify_level === 'nothing';
  try {
    await api.setNotifyLevel('channel', c.id, muted ? 'inherit' : 'nothing', null);
    store.notify.set(c.id, { notify_level: muted ? 'inherit' : 'nothing' });
    renderChannels();
    toast(muted ? 'Unmuted' : 'Muted');
  } catch (e) { toast(e.message, 'error'); }
}

export async function createChannelDialog() {
  const out = await formModal({
    title: 'Create a channel',
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'product-launch' },
      { name: 'kind', label: 'Type', type: 'select', options: [
        { value: 'text', label: 'Text' }, { value: 'voice', label: 'Voice' },
        { value: 'announcement', label: 'Announcement (only admins post)' },
        { value: 'forum', label: 'Forum (threaded posts)' },
      ] },
      { name: 'category', label: 'Category', type: 'select',
        options: [{ value: '', label: 'No category' },
          ...store.categories.map((c) => ({ value: c.id, label: c.name }))] },
      { name: 'is_private', label: 'Private (invite only)', type: 'checkbox' },
    ],
    submitLabel: 'Create',
  });
  if (!out) return;
  try {
    const c = await api.createChannel(
      store.ws.id, out.name.trim().toLowerCase().replace(/\s+/g, '-'),
      out.kind, out.category || null, !!out.is_private);
    toast('Created #' + (c?.name || out.name));
    bus.emit('channels:reload', { open: c?.id });
  } catch (e) { toast(e.message, 'error'); }
}

export async function editChannelDialog(c) {
  const out = await formModal({
    title: 'Edit #' + c.name,
    fields: [
      { name: 'name', label: 'Name', value: c.name },
      { name: 'topic', label: 'Topic', value: c.topic || '', placeholder: 'What is this channel for?' },
      { name: 'category', label: 'Category', type: 'select', value: c.category_id || '',
        options: [{ value: '', label: 'No category' },
          ...store.categories.map((x) => ({ value: x.id, label: x.name }))] },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;
  try {
    await api.updateChannel(c.id, {
      name: out.name !== c.name ? out.name.trim().toLowerCase().replace(/\s+/g, '-') : null,
      topic: out.topic !== (c.topic || '') ? out.topic : null,
      category: (out.category || null) !== (c.category_id || null) ? (out.category || null) : null,
    });
    toast('Channel updated');
    bus.emit('channels:reload');
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ open
// How many rows are painted in the FIRST frame. A page is fifty messages and a
// phone screen holds about twelve; building the other thirty-eight before
// showing anything costs 780ms of blank list on a mid-range Android for pixels
// nobody can see yet. The head lands, the list scrolls to the bottom, and the
// rest is stitched in above on the next frame where it is invisible anyway.
const HEAD_ROWS = 16;

// Paint the newest rows, then fill the scrollback in above them. Returns the
// number of rows actually rendered.
function paintPage(list, ordered, { head = HEAD_ROWS } = {}) {
  const gen = openGen;
  armPaging();
  list.innerHTML = '';
  resetWindow();
  if (ordered.length <= head + 8) {
    const n = renderBatch(list, ordered, 'channel');
    scrollDown();
    return n;
  }
  const cut = ordered.length - head;
  renderBatch(list, ordered.slice(cut), 'channel');
  scrollDown();
  // Next frame: the part that is above the fold. A tap on another channel in
  // between makes this batch belong to a conversation that is no longer open.
  requestAnimationFrame(() => {
    if (gen !== openGen || !list.isConnected) return;
    prependBatch(list, ordered.slice(0, cut), 'channel');
    scrollDown();
  });
  return ordered.length;
}

export async function openChannel(c, opts = {}) {
  if (!c) return;
  const gen = ++openGen;
  store.current = c;
  store.currentDM = null;
  resetChannelState();
  resetWindow();
  gapBuffer.clear();
  delivery.buffered = 0;
  if (!opts.keepPanel) closePanel();

  $('hdrName').textContent = '# ' + c.name;
  $('hdrTopic').textContent = c.topic || '';
  const composer = $('composer');
  if (composer) {
    composer.dataset.ph = 'Message #' + c.name;
    composer.placeholder = composer.dataset.ph;
    const d = store.drafts.get('channel:' + c.id);
    composer.value = d || '';
  }
  renderChannels();
  bus.emit('channel:open', { channel: c });

  const list = $('messages');

  // ---- 1. both server reads, at the same time.
  // These never depended on each other. `threads` only decides whether a reply
  // indicator paints under a message; awaiting it before even ASKING for the
  // messages put an unbounded query (224 rows, 19 KB, 193ms on a good line, six
  // seconds on a bad one) in front of the thing the person actually clicked.
  const pThreads = table('threads', (q) => q.eq('channel_id', c.id)).catch(() => []);
  const pMsgs = api.channelMessages(c.id, null, MESSAGE_PAGE)
    .then((r) => ({ rows: r || [] }), (e) => ({ err: e }));
  pThreads.then((threads) => {
    if (gen !== openGen) return;
    for (const t of threads) {
      if (!t.root_message_id) continue;
      store.rootThreads.set(t.root_message_id, {
        threadId: t.id, count: t.reply_count, last_message_at: t.last_message_at,
      });
      refreshThreadIndicator(t.root_message_id);
    }
  });

  // ---- 2. whatever this phone already has, on screen now.
  // peek() is synchronous on purpose: coming back to a channel you were in must
  // paint in the same frame as the tap, and even an await that resolves
  // immediately costs a frame.
  let cached = pagecache.peek(store.me, c.id);
  if (cached) {
    paintCached(list, cached);
  } else {
    list.innerHTML = '<div class="muted pad">loading…</div>';
    cached = await pagecache.recall(store.me, c.id);
    if (gen !== openGen) return;
    if (cached) paintCached(list, cached);
  }
  // The socket can go up while the page is still in flight. Anything it delivers
  // lands on top of the cached rows, and claimMessage keeps it from doubling.
  subscribeChannel(c);

  // ---- 3. the server's answer, folded into what is already there.
  const res = await pMsgs;
  if (gen !== openGen) return;
  if (res.err) {
    // A cached page on screen is worth far more than an error replacing it.
    if (!cached) list.innerHTML = `<div class="empty">${esc(res.err.message)}</div>`;
    return;
  }
  await pThreads;
  if (gen !== openGen) return;

  const ordered = res.rows.slice().reverse();
  const visible = ordered.filter(shouldShowInChannel);

  if (!cached) {
    if (!visible.length) {
      list.innerHTML = '';
      list.appendChild(el('div', 'empty',
        `This is the beginning of <b>#${esc(c.name)}</b>. Say hello.`));
    } else {
      for (const m of visible) claimMessage(m);
      paintPage(list, visible);
    }
  } else {
    mergeIntoCached(list, visible, cached);
  }

  // The cursor tracks the channel_events log, not message seq: an edit or delete
  // advances last_seq past the newest message. Take the larger of the two - a
  // cursor that is too low only replays idempotent events, one that is too high
  // silently drops them.
  store.cursor = Math.max(c.last_seq || 0, ordered.length ? ordered[ordered.length - 1].seq : 0);
  store.oldestSeq = ordered.length ? ordered[0].seq : null;
  pagecache.remember(store.me, c.id, {
    msgs: visible, threads: await pThreads, cursor: store.cursor, oldestSeq: store.oldestSeq,
  });

  loadReactions(ordered.map((m) => m.id)).catch(() => {});
  if (ordered.length) api.markRead('channel', c.id, store.cursor).then(refreshUnread).catch(() => {});
  if (opts.jumpSeq) jumpToSeq(c, opts.jumpSeq);
}

// Draw a snapshot from disk. Everything here is marked seen, so when the real
// page lands a moment later only the genuinely new rows are added.
function paintCached(list, snap) {
  for (const t of snap.threads || []) {
    if (t.root_message_id) {
      store.rootThreads.set(t.root_message_id, {
        threadId: t.id, count: t.reply_count, last_message_at: t.last_message_at,
      });
    }
  }
  const rows = (snap.msgs || []).filter((m) => !m.deleted_at).filter(shouldShowInChannel);
  for (const m of rows) claimMessage(m);
  paintPage(list, rows);
  store.cursor = snap.cursor || 0;
  store.oldestSeq = snap.oldestSeq ?? (rows.length ? rows[0].seq : null);
}

// Reconcile the painted-from-disk list against the page the server just sent.
// Three outcomes, in order of how common they are: identical (do nothing, which
// is the whole point), a few new messages at the end (append them), or the cache
// is older than one page so the two do not overlap at all (start again).
function mergeIntoCached(list, fresh, snap) {
  if (!fresh.length) return;
  const shownNewest = snap.msgs.length ? +(snap.msgs[snap.msgs.length - 1].seq || 0) : 0;
  const freshOldest = +(fresh[0].seq || 0);
  if (shownNewest && freshOldest > shownNewest + 1) {
    // The gap between the cached page and this one is bigger than a page: there
    // is no honest way to stitch them, so the server's copy wins outright.
    store.seen.clear();
    store.msgCache.clear();
    for (const m of fresh) claimMessage(m);
    paintPage(list, fresh);
    return;
  }
  const added = [];
  for (const m of fresh) {
    if (m.deleted_at) { applyDelete(m.id); continue; }
    const prev = store.msgCache.get(m.id);
    if (prev) {
      // Something changed while this phone was away from the channel.
      if (prev.body_text !== m.body_text) applyEdit(m.id, m.body_text);
      store.msgCache.set(m.id, m);
      continue;
    }
    if (!claimMessage(m)) continue;
    added.push(m);
  }
  if (!added.length) return;
  const stick = nearBottom();
  renderBatch(list, added, 'channel');
  capWindow(list);
  if (stick) scrollDown();
}

// A thread reply belongs in the side panel, NOT the channel - unless the author
// ticked "also send to channel". This single predicate is the Slack contract.
function shouldShowInChannel(m) {
  if (!m.thread_id) return true;
  if (m.also_send_to_channel) return true;
  return store.rootThreads.has(m.id); // the root message itself
}

function nearBottom() {
  const m = $('messages');
  return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}

// ------------------------------------------------------------------ realtime
function subscribeChannel(c) {
  subscribe('chan', 'ch:' + c.id, {
    msg: (m) => onIncoming(m),
    nudge: () => requestResync('nudge'),
    edit: (p) => { advanceOnEvent(p.event_seq); applyEdit(p.id, p.body_text); },
    delete: (p) => { advanceOnEvent(p.event_seq); applyDelete(p.message_id); },
    reaction: (p) => applyReaction(p),
    thread_created: (p) => {
      if (!p.root_message_id) return;
      store.rootThreads.set(p.root_message_id, {
        threadId: p.id, count: p.reply_count || 0, last_message_at: p.last_message_at,
      });
      refreshThreadIndicator(p.root_message_id);
    },
    voice_join: () => bus.emit('voice:refresh'),
    voice_leave: (p) => { bus.emit('voice:left', { userId: p?.user_id }); bus.emit('voice:refresh'); },
  }, {
    onStatus: (status) => {
      // Features bind their own handlers onto whatever object core holds for
      // 'chan'. That object is replaced on every switch AND on every recovered
      // drop, so tell them when a new one is live rather than making them poll
      // for it and give up after eight seconds.
      if (status === 'SUBSCRIBED') bus.emit('channel:subscribed', { channel: c });
    },
  });

  subscribe('typing', 'typ:' + c.id, {
    typing: (p) => { if (p.user_id !== store.me) bus.emit('typing', p); },
  }, { self: false });
}

// An edit or a delete moves the channel's event log forward without changing any
// message's own seq, so the cursor has to follow it or the very next message
// looks like a gap. The payload carries `event_seq` (0056) precisely for this;
// older servers omit it, in which case the next message triggers one harmless
// resync instead.
function advanceOnEvent(eventSeq) {
  const s = +(eventSeq || 0);
  if (!s) return;
  if (store.cursor && s > store.cursor + 1) { onGap(s, null); return; }
  store.cursor = Math.max(store.cursor, s);
}

// The branch this client never had. Telegram states all three:
//   local + count === incoming -> apply
//   local + count  >  incoming -> already applied, ignore
//   local + count  <  incoming -> A GAP. Fill it before applying.
// Soop implemented the middle one (Math.max on the cursor) and used it for the
// third, which quietly advanced the cursor PAST the missing span. reconcile()
// then asked for events after the new cursor and nobody ever asked for the
// dropped ones again. They came back only on a reload. This is that fix: hold
// the early message, leave the cursor where it is, and go and get the hole.
function onGap(seq, msg) {
  delivery.gaps++;
  if (msg && gapBuffer.size < GAP_BUFFER_MAX) gapBuffer.set(seq, msg);
  delivery.buffered = gapBuffer.size;
  requestResync('gap', GAP_GRACE_MS);
}

function onIncoming(m) {
  if (m.channel_id !== store.current?.id) return;
  const seq = +(m.seq || 0);
  if (seq && store.cursor && seq > store.cursor + 1) { onGap(seq, m); return; }
  applyIncoming(m);
}

function applyIncoming(m) {
  if (m.channel_id !== store.current?.id) return;
  if (m.seq) store.cursor = Math.max(store.cursor, m.seq);

  // A thread reply bumps the indicator instead of interrupting the channel.
  if (m.thread_id && !store.rootThreads.has(m.id)) {
    for (const [root, t] of store.rootThreads) {
      if (t.threadId === m.thread_id) {
        t.count = (t.count || 0) + 1;
        t.last_message_at = m.created_at;
        refreshThreadIndicator(root);
        break;
      }
    }
    if (!m.also_send_to_channel) {
      bus.emit('message:new', { msg: m, inThread: true });
      return;
    }
    // Deliberately broadcast into the channel. The thread panel may already have
    // claimed this id, so ask the channel list itself rather than the shared gate.
    const list = $('messages');
    if (renderedIn(list, m.id)) return;
    store.seen.add(m.id);
    const stickA = nearBottom();
    appendMessage(list, m, 'channel');
    if (stickA) scrollDown(); else showNewBelow();
    markReadSoon(store.current.id, m.seq);
    bus.emit('message:new', { msg: m });
    return;
  }

  if (!claimMessage(m)) return;
  const list = $('messages');
  const stick = nearBottom();
  // Paged up far enough that the tail has been trimmed out of the DOM: this
  // message belongs BELOW rows that are not on screen, so appending it here
  // would print it in the wrong place. Record it and let the jump-to-latest
  // path bring the whole tail back in order.
  if (windowState().below) {
    deferBelow(m);
    showNewBelow();
  } else {
    appendMessage(list, m, 'channel');
    capWindow(list);
    if (stick) scrollDown(); else showNewBelow();
  }
  pagecache.note(store.me, m.channel_id, m);
  markReadSoon(store.current.id, m.seq);
  bus.emit('message:new', { msg: m });
}

// mark_read is monotonic server-side (greatest(...)), so a burst of twenty
// messages needs one write, not twenty. Every one of those writes also fans a
// realtime event out to the sender, which nothing listens for.
let readTimer = null;
let readPending = null;
function markReadSoon(channelId, seq) {
  if (!seq) return;
  if (!readPending || readPending.id !== channelId || seq > readPending.seq) {
    readPending = { id: channelId, seq: Math.max(seq, readPending?.id === channelId ? readPending.seq : 0) };
  }
  if (readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    const p = readPending;
    readPending = null;
    if (p) api.markRead('channel', p.id, p.seq).catch(() => {});
  }, MARK_READ_MS);
}

function showNewBelow() {
  let b = $('newBelow');
  if (!b) {
    b = el('button', 'new-below', 'New messages ↓');
    b.id = 'newBelow';
    // jumpLatest rebuilds the tail in one bounded pass. Walking back down to it
    // a chunk at a time is not bounded, and after a long scroll up it is the
    // difference between instant and several seconds.
    b.onclick = () => { jumpLatest($('messages'), 'channel'); b.remove(); };
    $('messages').parentElement.appendChild(b);
  }
}

// ------------------------------------------------------------------ resync
// One entry point for "go and find out what I missed", debounced, so that a
// reconnect that fires SUBSCRIBED on four topics at once costs one pass and not
// four. Every caller names its reason; the harness and the tests read it back.
let resyncTimer = null;
let resyncing = false;
let resyncAgain = false;

export function requestResync(reason = 'manual', delay = 0) {
  delivery.lastReason = reason;
  delivery.lastAt = Date.now();
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => { resyncTimer = null; runResync(reason); }, delay);
}

async function runResync(reason) {
  if (resyncing) { resyncAgain = true; return; }
  resyncing = true;
  try {
    delivery.resyncs++;
    if (store.current) await reconcile();
    bus.emit('delivery:resync', { reason });     // DMs and anything else with a cursor
  } catch (e) {
    console.warn('resync', e?.message || e);
  } finally {
    resyncing = false;
    if (resyncAgain) { resyncAgain = false; requestResync(reason + '+', 60); }
  }
}

// Realtime is at-most-once, so anything can be dropped and the UI must heal
// itself. Reconciling against `messages` alone is not enough: an edit or a
// delete does not change the message's own seq, so a dropped edit/delete
// broadcast would never be repaired and that user would keep seeing a message
// everyone else has changed or removed.
//
// channel_events is the gapless log that covers all of it - send, edit, delete
// and pin each advance channels.last_seq and append a row. resume() (0056)
// returns everything past our cursor for ONE channel, plus the two numbers the
// client cannot know on its own: how far back the log still goes, and whether
// it withheld anything. That is Discord's RESUME - replay the span, do not
// refetch the world - with Telegram's differenceTooLong on the end of it.
export async function reconcile() {
  if (!store.current) return;
  const gen = openGen;
  const channelId = store.current.id;
  const startCursor = store.cursor;

  for (let page = 0; ; page++) {
    let r;
    try {
      r = await api.resume(channelId, store.cursor, RESUME_PAGE);
    } catch (e) {
      // Older deployment without 0056: fall back to the multi-channel sync().
      if (/schema cache|does not exist|404/i.test(e?.message || '')) return legacyReconcile(channelId, gen);
      return; // transient; an event or the backstop will try again
    }
    if (gen !== openGen || store.current?.id !== channelId) return;

    // Our position predates the retention floor - the span between them was
    // pruned and no replay can produce it. Telegram calls this
    // differenceTooLong and restarts the client's state; so do we.
    if (r?.too_old) { await resnapshot(channelId, 'too_old'); return; }

    const events = Array.isArray(r?.events) ? r.events : [];
    if (!events.length) break;
    await applyEvents(channelId, events, gen);
    if (gen !== openGen || store.current?.id !== channelId) return;

    if (!r.more) break;
    if (page + 1 >= RESUME_MAX_PAGES) { await resnapshot(channelId, 'too_far'); return; }
  }

  flushGapBuffer();
  if (store.cursor > startCursor) {
    api.markRead('channel', channelId, store.cursor).then(refreshUnread).catch(() => {});
  }
}

// Apply one page of the log. Anything healed here has to look EXACTLY like a
// live delivery to the rest of the app: same 'message:new' event, same read
// state. It did not before, which is why every reconnect left a phantom unread
// dot on the channel you were reading and why a recovered message never raised
// a notification.
async function applyEvents(channelId, events, gen) {
  const stick = nearBottom();
  const newIds = events.filter((e) => e.kind === 'msg').map((e) => e.message_id);
  const editedIds = events.filter((e) => e.kind === 'edit').map((e) => e.message_id);

  // One round trip for every message the log says we are missing or is stale.
  const wanted = [...new Set([...newIds, ...editedIds])];
  const byId = new Map();
  if (wanted.length) {
    const { data } = await sb.from('messages').select('*').in('id', wanted);
    for (const m of data || []) byId.set(m.id, m);
  }
  if (gen !== openGen || store.current?.id !== channelId) return;

  for (const e of events) {
    store.cursor = Math.max(store.cursor, e.seq);
    delivery.healed++;
    if (gapBuffer.has(e.seq)) { gapBuffer.delete(e.seq); delivery.buffered = gapBuffer.size; }
    if (e.kind === 'delete') { applyDelete(e.message_id); continue; }
    if (e.kind === 'edit') {
      const m = byId.get(e.message_id);
      if (m) applyEdit(m.id, m.body_text);
      continue;
    }
    if (e.kind !== 'msg') continue;         // 'pin' is repainted by the pins panel

    const m = byId.get(e.message_id);
    if (!m || m.deleted_at) continue;
    if (!shouldShowInChannel(m)) {
      for (const [root, t] of store.rootThreads) {
        if (t.threadId === m.thread_id) { t.count = (t.count || 0) + 1; refreshThreadIndicator(root); break; }
      }
      bus.emit('message:new', { msg: m, inThread: true, healed: true });
      continue;
    }
    if (!claimMessage(m)) continue;
    appendMessage($('messages'), m, 'channel');
    bus.emit('message:new', { msg: m, healed: true });
  }

  if (newIds.length) await loadReactions(newIds);
  if (stick) scrollDown(); else if (newIds.length) showNewBelow();
}

// Messages that arrived early are applied the moment the log has filled in
// everything beneath them. Anything still sitting above a hole stays buffered
// for the next pass rather than being applied out of order.
function flushGapBuffer() {
  if (!gapBuffer.size) return;
  for (const seq of [...gapBuffer.keys()].sort((a, b) => a - b)) {
    if (seq > store.cursor + 1) break;
    const m = gapBuffer.get(seq);
    gapBuffer.delete(seq);
    applyIncoming(m);
  }
  delivery.buffered = gapBuffer.size;
}

// The cursor is beyond what the log can replay. Throw local state away and load
// the channel again - and SAY so, because silently repainting the screen while
// someone is reading it is worse than a sentence explaining why.
async function resnapshot(channelId, why) {
  delivery.resnapshots++;
  const c = store.channels.find((x) => x.id === channelId) || store.current;
  if (!c) return;
  gapBuffer.clear();
  delivery.buffered = 0;
  toast(why === 'too_old'
    ? `You were away a while. Reloading #${c.name} from the server.`
    : `Catching up on #${c.name} - too much to replay.`);
  await openChannel(c, { keepPanel: true });
}

// Deployment without 0056 applied: sync() has no floor, no head and no "more",
// so this can heal a small gap and nothing else. Kept so a half-deployed client
// degrades instead of breaking.
async function legacyReconcile(channelId, gen) {
  let events;
  try { events = await api.sync([{ channel_id: channelId, seq: store.cursor }]); }
  catch { return; }
  if (gen !== openGen || store.current?.id !== channelId) return;
  if (!Array.isArray(events)) return;
  events = events.filter((e) => e.channel_id === channelId);
  if (!events.length) return;
  await applyEvents(channelId, events, gen);
  flushGapBuffer();
}

// ------------------------------------------------------------------ paging up
export async function loadOlder() {
  if (loadingOlder || !store.current || store.oldestSeq == null || store.oldestSeq <= 1) return;
  const gen = openGen;
  loadingOlder = true;
  const list = $('messages');
  try {
    const older = (await api.channelMessages(store.current.id, store.oldestSeq, MESSAGE_PAGE)) || [];
    if (gen !== openGen) return;
    if (!older.length) { store.oldestSeq = 1; return; }
    const ordered = older.slice().reverse().filter(shouldShowInChannel).filter(claimMessage);
    prependBatch(list, ordered, 'channel');
    capWindowTop(list);
    store.oldestSeq = older[older.length - 1].seq;
    loadReactions(ordered.map((m) => m.id)).catch(() => {});
  } finally { loadingOlder = false; }
}

export async function jumpToSeq(channel, seq) {
  try {
    const rows = (await api.messagesAround(channel.id, seq, 25, 25)) || [];
    if (!rows.length) return;
    const list = $('messages');
    list.innerHTML = '';
    resetChannelState();
    resetWindow();
    armPaging();
    renderBatch(list, rows.filter(shouldShowInChannel).filter(claimMessage), 'channel');
    loadReactions(rows.map((m) => m.id)).catch(() => {});
    store.oldestSeq = rows[0].seq;
    store.cursor = rows[rows.length - 1].seq;
    const target = rows.find((r) => r.seq === seq) || rows[Math.floor(rows.length / 2)];
    if (target?.id) jumpTo(target.id);
  } catch (e) { toast(e.message || 'Could not jump there', 'error'); }
}

export async function refreshUnread() {
  if (!store.ws) return;
  try {
    const rows = (await api.unread(store.ws.id)) || [];
    store.unread = new Map(rows.map((u) => [u.scope_id, u]));
    bus.emit('unread');
    renderChannels();
  } catch { /* transient */ }
  // Badges on the Space rail come from a separate cross-workspace rollup, so a
  // message in another Space still lights up its icon.
  try {
    const summary = await api.spaceSummary();
    if (Array.isArray(summary)) {
      store.spaceBadges = new Map(summary.map((s) => [s.workspace_id, s]));
      bus.emit('spaces:badges');
    }
  } catch { /* the rail just keeps its last state */ }

  await refreshDMList();
}

// A conversation someone else opens with me is not in the bootstrap snapshot I
// loaded, and there is no realtime event for "a DM now exists". Without this the
// first message from a new person is invisible until a reload, which reads as
// lost mail. Poll the DM list alongside unread.
export async function refreshDMList() {
  if (!store.ws) return;
  try {
    const rows = (await api.dmUnread(store.ws.id)) || [];
    if (!rows.length) return;
    const known = new Set(store.dms.map((d) => d.conversation_id));
    const fresh = rows.filter((r) => !known.has(r.conversation_id));

    if (fresh.length) {
      // Only the new conversations need their member lists resolved.
      const ids = fresh.map((r) => r.conversation_id);
      const members = await table('conversation_members', (q) => q.in('conversation_id', ids));
      const missing = [...new Set(members.map((m) => m.user_id))]
        .filter((u) => !store.profiles.has(u));
      if (missing.length) {
        const profs = await table('profiles', (q) => q.in('id', missing));
        for (const p of profs) store.profiles.set(p.id, p);
      }
      for (const r of fresh) {
        store.dms.push({
          conversation_id: r.conversation_id,
          other_user_ids: members.filter((m) => m.conversation_id === r.conversation_id)
            .map((m) => m.user_id),
          last_message_at: r.last_message_at,
          unread: r.unread ? 1 : 0,
        });
      }
    }
    for (const d of store.dms) {
      const row = rows.find((r) => r.conversation_id === d.conversation_id);
      if (row) { d.unread = row.unread ? 1 : 0; d.last_message_at = row.last_message_at; }
    }
    if (fresh.length) renderChannels();
  } catch { /* transient */ }
}

// scroll handler for paging up
//
// The old version fired loadOlder() on any scroll event with scrollTop < 120,
// and scrollTop is 0 for as long as the first page is still being laid out. On a
// 3G phone that is ten seconds, during which it pulled EIGHT more pages nobody
// asked for: 427 messages instead of 49, 27,224 DOM nodes, eight round trips,
// and the newest message not scrolled into view until it was all over. Measured,
// reproducibly, on the first open after every load.
//
// Two gates fix it. Nothing pages until the opening paint has settled, and
// nothing pages until the person has actually moved the list themselves - a
// scroll event the app caused by scrolling to the bottom is not a request for
// history.
let pageGate = 0;
let userScrolled = false;

export function armPaging(delayMs = 900) {
  pageGate = Date.now() + delayMs;
  userScrolled = false;
}

export function wireScroll() {
  const list = $('messages');
  if (!list) return;
  let lastTop = 0;
  list.addEventListener('scroll', () => {
    if (list.scrollTop !== lastTop) {
      if (list.scrollTop > 0 || lastTop > 0) userScrolled = true;
      lastTop = list.scrollTop;
    }
  }, { passive: true });
  for (const ev of ['wheel', 'touchmove', 'keydown']) {
    list.addEventListener(ev, () => { userScrolled = true; }, { passive: true });
  }

  list.addEventListener('scroll', debounce(() => {
    const scrollable = list.scrollHeight - list.clientHeight > 40;
    if (list.scrollTop < 120 && Date.now() > pageGate && (userScrolled || !scrollable)) {
      // Rows this client already had and trimmed out of the DOM come back first.
      // They cost no round trip at all.
      if (!restoreAbove(list)) loadOlder();
    }
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 60) {
      if (restoreBelow(list)) return;      // more tail to bring back before the button goes
      $('newBelow')?.remove();
    }
  }, 120));
}

bus.on('channel:request', ({ channelId }) => {
  const c = store.channels.find((x) => x.id === channelId);
  if (c) openChannel(c);
});

// ------------------------------------------------------------------ triggers
// This is the whole point of the rewrite: reconciliation is driven by things
// that HAPPEN, not by a stopwatch. A rejoin is Discord's RESUME moment - the
// socket was away, so by definition it missed whatever was published while it
// was gone, and the cursor is the only thing that can say what.
bus.on('realtime:subscribed', ({ key, rejoined }) => {
  if (!rejoined) return;                        // a first join has nothing to catch up on
  if (key === 'chan' || key === 'user' || key === 'ws') requestResync('rejoin:' + key);
});

// A topic going down is the earliest honest signal that delivery has stopped.
// Nothing can be fetched until it is back, but the moment it is, resync.
bus.on('realtime:down', ({ key }) => { delivery.lastReason = 'down:' + key; });
