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
  refreshThreadIndicator, jumpTo, buildMessage, scrollDown } from './messages.js';

export { scrollDown };

let loadingOlder = false;

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
export async function openChannel(c, opts = {}) {
  if (!c) return;
  store.current = c;
  store.currentDM = null;
  resetChannelState();
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
  list.innerHTML = '<div class="muted pad">loading…</div>';

  // thread map for this channel, so indicators paint on first render
  const threads = await table('threads', (q) => q.eq('channel_id', c.id));
  for (const t of threads) {
    if (t.root_message_id) {
      store.rootThreads.set(t.root_message_id, {
        threadId: t.id, count: t.reply_count, last_message_at: t.last_message_at,
      });
    }
  }

  let msgs = [];
  try { msgs = (await api.channelMessages(c.id, null, MESSAGE_PAGE)) || []; }
  catch (e) { list.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const ordered = msgs.slice().reverse();
  list.innerHTML = '';
  if (!ordered.length) {
    list.appendChild(el('div', 'empty',
      `This is the beginning of <b>#${esc(c.name)}</b>. Say hello.`));
  }
  for (const m of ordered) {
    if (!shouldShowInChannel(m)) continue;
    if (!claimMessage(m)) continue;
    appendMessage(list, m, 'channel');
  }
  await loadReactions(ordered.map((m) => m.id));
  // The cursor tracks the channel_events log, not message seq: an edit or delete
  // advances last_seq past the newest message. Take the larger of the two - a
  // cursor that is too low only replays idempotent events, one that is too high
  // silently drops them.
  store.cursor = Math.max(c.last_seq || 0, ordered.length ? ordered[ordered.length - 1].seq : 0);
  store.oldestSeq = ordered.length ? ordered[0].seq : null;
  scrollDown();

  if (ordered.length) api.markRead('channel', c.id, store.cursor).then(refreshUnread).catch(() => {});
  subscribeChannel(c);
  if (opts.jumpSeq) jumpToSeq(c, opts.jumpSeq);
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
    nudge: () => reconcile(),
    edit: (p) => applyEdit(p.id, p.body_text),
    delete: (p) => applyDelete(p.message_id),
    reaction: (p) => applyReaction(p),
    thread_created: (p) => {
      if (!p.root_message_id) return;
      store.rootThreads.set(p.root_message_id, {
        threadId: p.id, count: p.reply_count || 0, last_message_at: p.last_message_at,
      });
      refreshThreadIndicator(p.root_message_id);
    },
    voice_join: () => bus.emit('voice:refresh'),
    voice_leave: () => bus.emit('voice:refresh'),
  });

  subscribe('typing', 'typ:' + c.id, {
    typing: (p) => { if (p.user_id !== store.me) bus.emit('typing', p); },
  }, { self: false });
}

function onIncoming(m) {
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
  }

  if (!claimMessage(m)) return;
  const stick = nearBottom();
  appendMessage($('messages'), m, 'channel');
  if (stick) scrollDown();
  else showNewBelow();
  api.markRead('channel', store.current.id, m.seq).catch(() => {});
  bus.emit('message:new', { msg: m });
}

function showNewBelow() {
  let b = $('newBelow');
  if (!b) {
    b = el('button', 'new-below', 'New messages ↓');
    b.id = 'newBelow';
    b.onclick = () => { scrollDown(); b.remove(); };
    $('messages').parentElement.appendChild(b);
  }
}

// Realtime is at-most-once, so anything can be dropped and the UI must heal
// itself. Reconciling against `messages` alone is not enough: an edit or a
// delete does not change the message's own seq, so a dropped edit/delete
// broadcast would never be repaired and that user would keep seeing a message
// everyone else has changed or removed.
//
// channel_events is the gapless log that covers all of it - send, edit, delete
// and pin each advance channels.last_seq and append a row. sync() returns
// everything past our cursor for the channels we can see, so that is what we
// replay.
export async function reconcile() {
  if (!store.current) return;
  const channelId = store.current.id;

  let events;
  try {
    events = await api.sync([{ channel_id: channelId, seq: store.cursor }]);
  } catch {
    return; // transient; the next tick tries again
  }
  if (!Array.isArray(events) || !events.length) return;
  // sync() can span several channels; only this one is on screen.
  events = events.filter((e) => e.channel_id === channelId);
  if (!events.length) return;

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

  for (const e of events) {
    store.cursor = Math.max(store.cursor, e.seq);
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
      continue;
    }
    if (!claimMessage(m)) continue;
    appendMessage($('messages'), m, 'channel');
  }

  if (newIds.length) await loadReactions(newIds);
  if (stick) scrollDown();
}

// ------------------------------------------------------------------ paging up
export async function loadOlder() {
  if (loadingOlder || !store.current || store.oldestSeq == null || store.oldestSeq <= 1) return;
  loadingOlder = true;
  const list = $('messages');
  const prevH = list.scrollHeight;
  try {
    const older = (await api.channelMessages(store.current.id, store.oldestSeq, MESSAGE_PAGE)) || [];
    if (!older.length) { store.oldestSeq = 1; return; }
    const ordered = older.slice().reverse();
    const frag = document.createDocumentFragment();
    const holder = el('div');
    for (const m of ordered) {
      if (!shouldShowInChannel(m)) continue;
      if (!claimMessage(m)) continue;
      appendMessage(holder, m, 'channel');
    }
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    list.insertBefore(frag, list.firstChild);
    store.oldestSeq = ordered[0].seq;
    await loadReactions(ordered.map((m) => m.id));
    list.scrollTop = list.scrollHeight - prevH;
  } finally { loadingOlder = false; }
}

export async function jumpToSeq(channel, seq) {
  try {
    const rows = (await api.messagesAround(channel.id, seq, 25, 25)) || [];
    if (!rows.length) return;
    const list = $('messages');
    list.innerHTML = '';
    resetChannelState();
    for (const m of rows) {
      if (!shouldShowInChannel(m)) continue;
      if (!claimMessage(m)) continue;
      appendMessage(list, m, 'channel');
    }
    await loadReactions(rows.map((m) => m.id));
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
export function wireScroll() {
  const list = $('messages');
  if (!list) return;
  list.addEventListener('scroll', debounce(() => {
    if (list.scrollTop < 120) loadOlder();
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 60) $('newBelow')?.remove();
  }, 120));
}

bus.on('channel:request', ({ channelId }) => {
  const c = store.channels.find((x) => x.id === channelId);
  if (c) openChannel(c);
});
