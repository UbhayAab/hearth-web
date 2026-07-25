// Direct messages. Same rendering path as channels so DMs get reactions,
// attachments, replies and the in-app media viewer for free.
import { sb, subscribe } from '../sb.js';
import { api, table, tryRpc } from '../api.js';
import { store, bus, nameOf, resetChannelState } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast, modal, closePanel } from '../ui.js';
import { appendMessage, claimMessage, loadReactions, applyReaction } from './messages.js';
import { renderChannels } from './channels.js';
import { avatarHtml } from './messages.js';

export async function openDM(conversationId) {
  store.current = null;
  store.currentDM = conversationId;
  resetChannelState();
  closePanel();

  const conv = store.dms.find((d) => d.conversation_id === conversationId);
  const others = (conv?.other_user_ids || []).filter((u) => u !== store.me);
  const label = others.length ? others.map(nameOf).join(', ') : 'you';
  $('hdrName').textContent = '@ ' + label;
  $('hdrTopic').textContent = '';
  const c = $('composer');
  c.dataset.ph = 'Message ' + label;
  c.placeholder = c.dataset.ph;
  c.value = store.drafts.get('dm:' + conversationId) || '';
  renderChannels();

  const list = $('messages');
  list.innerHTML = '<div class="muted pad">loading…</div>';
  const msgs = await table('dm_messages', (q) =>
    q.eq('conversation_id', conversationId).order('seq', { ascending: true }).limit(80));
  list.innerHTML = '';
  if (!msgs.length) {
    list.appendChild(el('div', 'empty', `This is the start of your conversation with <b>${esc(label)}</b>.`));
  }
  for (const m of msgs) {
    if (!claimMessage(m)) continue;
    appendMessage(list, m, 'dm');
  }
  await loadReactions(msgs.map((m) => m.id));
  list.scrollTop = list.scrollHeight;

  const lastSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;
  if (lastSeq) api.markDMRead(conversationId, lastSeq).catch(() => {});

  subscribe('dm', 'dm:' + conversationId, {
    msg: (m) => {
      if (store.currentDM !== conversationId) return;
      if (!claimMessage(m)) return;
      appendMessage($('messages'), m, 'dm');
      $('messages').scrollTop = $('messages').scrollHeight;
      api.markDMRead(conversationId, m.seq).catch(() => {});
    },
    reaction: (p) => applyReaction(p),
    read: () => bus.emit('dm:receipts', { conversationId }),
  });

  bus.emit('dm:open', { conversationId });
  refreshReceipts(conversationId);
}

async function refreshReceipts(conversationId) {
  const [rows] = await tryRpc('get_dm_receipts', { p_conversation: conversationId });
  if (!Array.isArray(rows)) return;
  const others = rows.filter((r) => r.user_id !== store.me);
  const host = $('dmReceipt');
  if (!host) return;
  if (!others.length) { host.textContent = ''; return; }
  const seenUpTo = Math.max(...others.map((r) => r.last_read_seq || 0));
  const lastMine = [...document.querySelectorAll('.msg.me')].pop();
  const mySeq = lastMine ? +(lastMine.dataset.seq || 0) : 0;
  host.textContent = mySeq && seenUpTo >= mySeq ? 'Seen' : '';
}

export async function startDM(userId) {
  try {
    const conv = await api.createDM(store.ws.id, [userId]);
    if (!store.dms.find((d) => d.conversation_id === conv.id)) {
      store.dms.push({ conversation_id: conv.id, kind: conv.kind, other_user_ids: [userId, store.me], unread: 0 });
    }
    await openDM(conv.id);
    renderChannels();
  } catch (e) { toast(e.message, 'error'); }
}

export function newDMDialog() {
  const box = el('div', 'picker-list');
  const search = el('input');
  search.placeholder = 'Search people';
  const list = el('div', 'picker-rows');
  box.append(search, list);

  const draw = (q = '') => {
    const rows = [...store.profiles.values()]
      .filter((p) => p.id !== store.me)
      .filter((p) => !q || (p.display_name || '').toLowerCase().includes(q.toLowerCase())
        || (p.username || '').toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = '';
    if (!rows.length) { list.appendChild(el('div', 'empty', 'Nobody else here yet. Invite someone first.')); return; }
    for (const p of rows) {
      const r = el('div', 'picker-row');
      r.innerHTML = `${avatarHtml(p.id, 26)}<span>${esc(p.display_name || p.username)}</span>
        ${store.online.has(p.id) ? '<span class="dot on"></span>' : ''}`;
      r.onclick = () => { m.close(); startDM(p.id); };
      list.appendChild(r);
    }
  };
  const m = modal({ title: 'New message', body: box });
  search.oninput = () => draw(search.value);
  draw();
}

bus.on('dm:request', ({ conversationId }) => openDM(conversationId));
bus.on('dm:new', newDMDialog);
