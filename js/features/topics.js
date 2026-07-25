// Topics - Zulip's second axis inside a channel.
//
// A topic is nothing but a string stamped on a message, which is exactly why it
// works: no new container to create, no permission to grant, no migration. The
// feature is "group the channel by that string, then let one strand be read on
// its own". Everything here is a view over `messages.topic`.
import { hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, relTime } from '../util.js';
import { table } from '../api.js';
import { buildMessage } from '../core/messages.js';

let ui, api, store, bus, sb;

// The nav host we last painted into. renderNavSections() hands us a fresh host
// every time the sidebar is rebuilt, so we keep the live one to repaint in place.
let navHost = null;

// One channel open means several paint requests (renderChannels fires its own
// nav pass, and so does our channel:open listener). Cache the last answer for a
// beat so the second painter draws instantly instead of hitting the server again.
let cache = { channel: null, at: 0, rows: null, counts: null };
const CACHE_MS = 1500;

export function register(app) {
  ({ ui, api, store, bus, sb } = app);
  injectStyle();

  ui.addNavSection({ id: 'topics', order: 20, render: (host) => paintNav(host) });

  ui.registerPanel({
    id: 'topic',
    title: (ctx) => (ctx && ctx.topic ? '≡ ' + ctx.topic : 'Topic'),
    render: renderTopicPanel,
  });

  ui.addMessageAction({
    id: 'set-topic', label: '🏷', title: 'Set topic', order: 40,
    contexts: ['channel', 'thread'],
    // The server refuses a topic on someone else's message unless you can manage
    // messages, so do not offer a button that is only going to error.
    show: (m) => !!m.id && !m.conversation_id &&
      (m.author_id === store.me || hasPerm(PERM.MANAGE_MESSAGES)),
    onClick: (m) => setTopicDialog(m),
  });

  // The topic pill that core already draws on a message is a dead chip until
  // something claims it. Claim it: clicking a topic should read that topic.
  bus.on('message:render', ({ msg, el: row }) => {
    const pill = row.querySelector('.pill-topic');
    if (!pill) return;
    pill.onclick = (ev) => {
      ev.stopPropagation();
      openTopic(msg.channel_id || store.current?.id, pill.dataset.topic);
    };
  });

  bus.on('channel:open', () => {
    // openChannel() calls renderChannels() without awaiting it, so we cannot
    // rely on the nav pass having happened yet. Repaint the host we still own;
    // if the sidebar was rebuilt underneath us the nav pass covers it.
    if (navHost && navHost.isConnected) paintNav(navHost);
  });
}

// ------------------------------------------------------------------ nav section
async function paintNav(host) {
  navHost = host;
  const ch = store.current;
  // Topics live in the message stream. A forum channel has posts instead and a
  // voice channel has no messages at all.
  if (!ch || ch.kind === 'forum' || ch.kind === 'voice') { host.innerHTML = ''; return; }

  const fresh = cache.channel === ch.id && Date.now() - cache.at < CACHE_MS && cache.rows;
  let rows = fresh ? cache.rows : null;
  let counts = fresh ? cache.counts : null;

  if (!fresh) {
    // No "loading" line on purpose: this section is repainted on every channel
    // switch and a placeholder that lives 200ms only reads as flicker.
    try {
      rows = (await api.listTopics(ch.id)) || [];
    } catch (e) {
      if (store.current?.id !== ch.id) return;
      host.innerHTML = `<h3><span>Topics</span></h3>
        <div class="topics-msg">${esc(e.message)}</div>`;
      return;
    }
    if (store.current?.id !== ch.id) return; // channel changed while we fetched
    counts = rows.length ? await unreadCounts(ch.id) : null;
    if (store.current?.id !== ch.id) return;
    cache = { channel: ch.id, at: Date.now(), rows, counts };
  }

  // Nothing to group by means no section at all - an empty "Topics" header in
  // the sidebar of every channel would be pure noise.
  if (!rows.length) { host.innerHTML = ''; return; }

  let h = '<h3><span>Topics</span></h3><div class="navgroup">';
  for (const t of rows) {
    const n = counts ? counts.get(t.topic) || 0 : 0;
    const unread = counts ? n > 0 : !!t.unread;
    const tail = unread && counts && n
      ? `<span class="badge">${n}</span>`
      : unread ? '<span class="dot-unread"></span>'
        : `<span class="topics-count">${Number(t.message_count) || 0}</span>`;
    h += `<div class="chan${unread ? ' unread' : ''}" data-topic="${esc(t.topic)}"
      title="${esc(t.topic)} · ${Number(t.message_count) || 0} messages · last ${esc(relTime(t.last_message_at))}">
      <span class="ch-ico">≡</span><span class="ch-name">${esc(t.topic)}</span>${tail}</div>`;
  }
  h += '</div>';
  host.innerHTML = h;

  host.querySelectorAll('[data-topic]').forEach((n) => {
    n.onclick = () => openTopic(ch.id, n.dataset.topic);
  });
}

// list_topics answers "is this topic unread" with a boolean. A bare dot is much
// weaker than a number in a sidebar, so derive the real count from my own read
// cursor and the recent seqs. Best effort - a failure here just costs the badge.
async function unreadCounts(channelId) {
  try {
    const [reads, res] = await Promise.all([
      table('topic_read_state', (q) => q.eq('channel_id', channelId)),
      sb.from('messages').select('topic,seq')
        .eq('channel_id', channelId)
        .not('topic', 'is', null)
        .is('deleted_at', null)
        .order('seq', { ascending: false })
        .limit(500),
    ]);
    if (res.error) return null;
    const readAt = new Map(reads.map((r) => [r.topic, r.last_read_seq || 0]));
    const out = new Map();
    for (const m of res.data || []) {
      if ((m.seq || 0) > (readAt.get(m.topic) || 0)) out.set(m.topic, (out.get(m.topic) || 0) + 1);
    }
    return out;
  } catch { return null; }
}

function refreshNav() {
  cache = { channel: null, at: 0, rows: null, counts: null };
  if (navHost && navHost.isConnected) paintNav(navHost);
  else ui.renderNavSections();
}

export function openTopic(channelId, topic) {
  if (!channelId || !topic) return;
  const ch = store.channels.find((c) => c.id === channelId);
  ui.openPanel('topic', { channelId, channelName: ch?.name || store.current?.name || '', topic });
}

// ------------------------------------------------------------------ topic panel
async function renderTopicPanel(body, ctx = {}) {
  const topic = ctx.topic;
  const channelId = ctx.channelId || store.current?.id;
  if (!topic || !channelId) {
    body.innerHTML = `<div class="empty">No topic open. Pick one from <b>Topics</b> under the
      channel list - a topic is every message in a channel tagged with the same name,
      read as one strand.</div>`;
    return;
  }

  body.innerHTML = '<div class="muted pad">loading…</div>';
  let msgs;
  try {
    msgs = (await api.topicMessages(channelId, topic, 200)) || [];
  } catch (e) {
    body.innerHTML = `<div class="empty">Could not load this topic: ${esc(e.message)}</div>`;
    return;
  }

  body.innerHTML = '';
  body.appendChild(topicHeader(ctx, channelId, topic, msgs.length));

  if (!msgs.length) {
    body.appendChild(el('div', 'empty',
      `Nothing is filed under <b>${esc(topic)}</b> any more. Use <b>Set topic</b> on a message
       to put it here.`));
    return;
  }

  const list = el('div', 'topics-msgs');
  for (const m of msgs) {
    const row = buildMessage(m, { context: 'static' });
    // The same message can be on screen twice (channel + this panel). Drop the
    // duplicate element id so jumping to a message still lands in the channel.
    row.removeAttribute('id');
    row.classList.add('topics-row');
    row.onclick = () => bus.emit('message:jump', { messageId: m.id });
    list.appendChild(row);
  }
  body.appendChild(list);

  // Opening the strand is the read receipt - there is nothing else to click.
  const maxSeq = msgs.reduce((a, m) => Math.max(a, m.seq || 0), 0);
  if (maxSeq) {
    api.markTopicRead(channelId, topic, maxSeq).then(refreshNav).catch(() => { /* read state is not worth a toast */ });
  }
}

function topicHeader(ctx, channelId, topic, count) {
  const head = el('div', 'topics-head');
  const canManage = hasPerm(PERM.MANAGE_MESSAGES);
  head.innerHTML = `
    <div class="muted">in #${esc(ctx.channelName || store.current?.name || '')} ·
      ${count} ${count === 1 ? 'message' : 'messages'}</div>
    <div class="row gap topics-tools">
      ${canManage ? '<button class="ghost sm" data-a="rename">Rename</button>' : ''}
      ${canManage ? '<button class="ghost sm" data-a="clear">Remove topic</button>' : ''}
    </div>`;

  head.querySelector('[data-a="rename"]')?.addEventListener('click', async () => {
    const out = await ui.formModal({
      title: 'Rename topic',
      note: 'Every message under this topic moves, and read cursors move with it.',
      fields: [{ name: 'name', label: 'New topic name', value: topic, required: true }],
      submitLabel: 'Rename',
    });
    if (!out) return;
    const to = out.name.trim();
    if (!to || to === topic) return;
    try {
      const moved = await api.moveTopic(channelId, topic, to);
      ui.toast(`Moved ${moved} ${moved === 1 ? 'message' : 'messages'} to ${to}`, 'success');
      refreshNav();
      ui.openPanel('topic', { ...ctx, channelId, topic: to });
    } catch (e) { ui.toast(e.message, 'error'); }
  });

  head.querySelector('[data-a="clear"]')?.addEventListener('click', async () => {
    const ok = await ui.confirmModal({
      title: 'Remove the topic',
      body: `The messages stay in the channel, they just stop being grouped under "${topic}".`,
      confirmLabel: 'Remove topic', danger: true,
    });
    if (!ok) return;
    try {
      const moved = await api.moveTopic(channelId, topic, '');
      ui.toast(`Untagged ${moved} ${moved === 1 ? 'message' : 'messages'}`, 'success');
      refreshNav();
      ui.closePanel();
    } catch (e) { ui.toast(e.message, 'error'); }
  });

  return head;
}

// ------------------------------------------------------------------ set topic
// formModal has no datalist, and a datalist is the whole point here: people
// should fall into the topics that already exist rather than mint near-duplicates.
async function setTopicDialog(m) {
  const channelId = m.channel_id || store.current?.id;
  const box = el('div', 'form');
  box.innerHTML = `
    <label class="field"><span class="field-label">Topic</span>
      <input id="topicInput" list="topicOptions" maxlength="200"
        placeholder="release-2-0" value="${esc(m.topic || '')}" />
      <datalist id="topicOptions"></datalist>
      <span class="field-hint">Messages sharing a topic can be read on their own.
        Leave it empty to take this message out of its topic.</span></label>`;

  const dlg = ui.modal({
    title: 'Set topic',
    body: box,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (close) => close() },
      {
        label: 'Save',
        onClick: async (close) => {
          const value = box.querySelector('#topicInput').value.trim();
          close();
          try {
            await api.setMessageTopic(m.id, value);
            ui.toast(value ? 'Filed under ' + value : 'Topic removed', 'success');
            paintTopicPill(m.id, value);
            refreshNav();
          } catch (e) { ui.toast(e.message, 'error'); }
        },
      },
    ],
  });

  const input = box.querySelector('#topicInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dlg.foot.querySelector('button:last-child').click(); }
  });

  // Suggestions are a nicety, never a blocker: the dialog is already usable.
  if (!channelId) return;
  try {
    const rows = (await api.listTopics(channelId)) || [];
    const dl = box.querySelector('#topicOptions');
    if (dl) dl.innerHTML = rows.map((r) => `<option value="${esc(r.topic)}"></option>`).join('');
  } catch { /* no suggestions, still typable */ }
}

// Keep the row on screen honest without a full channel reload.
function paintTopicPill(messageId, topic) {
  const row = document.getElementById('m' + messageId);
  const head = row?.querySelector('.mhead');
  if (!head) return;
  const existing = head.querySelector('.pill-topic');
  if (!topic) { existing?.remove(); return; }
  const pill = existing || el('span', 'pill pill-topic');
  pill.dataset.topic = topic;
  pill.textContent = topic;
  pill.onclick = (ev) => {
    ev.stopPropagation();
    openTopic(store.current?.id, topic);
  };
  if (!existing) head.insertBefore(pill, head.querySelector('.t') || null);
  const cached = store.msgCache.get(messageId);
  if (cached) store.msgCache.set(messageId, { ...cached, topic });
}

// ------------------------------------------------------------------ styles
function injectStyle() {
  if (document.getElementById('topics-style')) return;
  const s = document.createElement('style');
  s.id = 'topics-style';
  s.textContent = `
    .topics-count{margin-left:auto;font-size:11px;color:var(--faint);flex:none}
    .topics-msg{color:var(--faint);font-size:12px;padding:2px 8px 6px}
    .topics-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
      padding:2px 4px 8px;border-bottom:1px solid var(--line);margin-bottom:6px}
    .topics-head .topics-tools{margin-left:auto}
    .topics-msgs .topics-row{cursor:pointer;border-radius:8px}
    .topics-msgs .topics-row .gutter{width:34px}
  `;
  document.head.appendChild(s);
}
