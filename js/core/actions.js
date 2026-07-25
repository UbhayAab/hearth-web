// Default message actions and the core side panels (search, pins, members,
// activity, saved). Feature modules add to these registries rather than editing
// this file.
import { sb } from '../sb.js';
import { api, table, tryRpc } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, fmt, plain, relTime, timeOf, toLocalInput, fromLocalInput } from '../util.js';
import { addMessageAction, addHeaderButton, registerPanel, openPanel, toast, modal,
  formModal, confirmModal, contextMenu, addSwitcherSource } from '../ui.js';
import { buildMessage, avatarHtml, jumpTo } from './messages.js';
import { icon } from '../icons.js';
import { setReply } from './composer.js';
import { openThread } from './threads.js';
import { openChannel } from './channels.js';
import { startDM } from './dms.js';

const mine = (m) => m.author_id === store.me;

// ------------------------------------------------------------------ actions
export function registerCoreActions() {
  addMessageAction({
    id: 'thread', label: icon('thread'), title: 'Reply in thread', order: 10,
    contexts: ['channel'],
    onClick: (m) => openThread(m),
  });
  addMessageAction({
    id: 'reply', label: icon('reply'), title: 'Quote reply (posts to the channel)', order: 20,
    onClick: (m) => setReply(m),
  });
  addMessageAction({
    id: 'more', label: icon('more'), title: 'More actions', order: 900,
    onClick: (m, ev) => moreMenu(m, ev),
  });
}

function moreMenu(m, ev) {
  const isPinned = false;
  contextMenu(ev, [
    { label: 'Forward to a channel', onClick: () => forwardDialog(m) },
    { label: 'Copy link to message', onClick: () => copyLink(m) },
    { label: 'Save for later', onClick: () => api.laterAdd(m.id).then(() => toast('Added to Later')).catch((e) => toast(e.message, 'error')) },
    { label: 'Remind me…', onClick: () => remindDialog(m) },
    { label: 'Bookmark', onClick: () => api.saveItem(m.id).then(() => toast('Saved')).catch((e) => toast(e.message, 'error')) },
    { label: 'Mark unread from here', onClick: () => api.markUnread('channel', store.current.id, m.seq).then(() => { toast('Marked unread'); bus.emit('unread:reload'); }).catch((e) => toast(e.message, 'error')) },
    '-',
    { label: 'Pin to channel', show: hasPerm(PERM.MANAGE_MESSAGES) || mine(m), onClick: () => api.pin(m.id).then(() => toast('Pinned')).catch((e) => toast(e.message, 'error')) },
    { label: 'Mark urgent', show: mine(m) || hasPerm(PERM.MANAGE_MESSAGES), onClick: () => api.setPriority(m.id, 'urgent').then(() => toast('Marked urgent')).catch((e) => toast(e.message, 'error')) },
    { label: 'Acknowledge', onClick: () => api.ack(m.id).then(() => toast('Acknowledged')).catch((e) => toast(e.message, 'error')) },
    '-',
    { label: 'Edit', show: mine(m), onClick: () => editDialog(m) },
    { label: 'Delete', danger: true, show: mine(m) || hasPerm(PERM.MANAGE_MESSAGES), onClick: async () => {
      if (!(await confirmModal({ title: 'Delete message', body: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
      try { await api.del(m.id); } catch (e) { toast(e.message, 'error'); }
    } },
    { label: 'Report', show: !mine(m), danger: true, onClick: () => reportDialog(m) },
  ]);
}

async function editDialog(m) {
  const out = await formModal({
    title: 'Edit message',
    fields: [{ name: 'text', label: '', type: 'textarea', value: m.body_text, rows: 5, required: true }],
    submitLabel: 'Save',
  });
  if (!out) return;
  try { await api.edit(m.id, out.text); } catch (e) { toast(e.message, 'error'); }
}

async function reportDialog(m) {
  const out = await formModal({
    title: 'Report message',
    fields: [{ name: 'reason', label: 'What is wrong with it?', type: 'textarea', required: true }],
    submitLabel: 'Send report',
  });
  if (!out) return;
  try { await api.reportMessage(m.id, out.reason); toast('Reported to the moderators'); }
  catch (e) { toast(e.message, 'error'); }
}

async function remindDialog(m) {
  const out = await formModal({
    title: 'Remind me about this',
    fields: [
      { name: 'when', label: 'When', type: 'select', options: [
        { value: '20m', label: 'In 20 minutes' }, { value: '1h', label: 'In 1 hour' },
        { value: '3h', label: 'In 3 hours' }, { value: 'tomorrow', label: 'Tomorrow morning' },
        { value: 'custom', label: 'Pick a time' }] },
      { name: 'custom', label: 'Custom time', type: 'datetime-local', value: toLocalInput(Date.now() + 3600000) },
      { name: 'note', label: 'Note (optional)' },
    ],
    submitLabel: 'Set reminder',
  });
  if (!out) return;
  let at;
  const now = Date.now();
  if (out.when === '20m') at = new Date(now + 20 * 60000);
  else if (out.when === '1h') at = new Date(now + 3600000);
  else if (out.when === '3h') at = new Date(now + 3 * 3600000);
  else if (out.when === 'tomorrow') { at = new Date(now + 86400000); at.setHours(9, 0, 0, 0); }
  else at = new Date(fromLocalInput(out.custom));
  try { await api.remindMe(m.id, at.toISOString(), out.note || null); toast('Reminder set'); }
  catch (e) { toast(e.message, 'error'); }
}

export async function copyLink(m) {
  try {
    const d = await api.permalink(m.id);
    const url = location.origin + location.pathname + '#/m/' + d.channel_id + '/' + d.seq;
    await navigator.clipboard?.writeText(url);
    toast('Link copied');
  } catch (e) { toast(e.message, 'error'); }
}

function forwardDialog(m) {
  const box = el('div', 'picker-list');
  const search = el('input');
  search.placeholder = 'Forward to…';
  const list = el('div', 'picker-rows');
  box.append(search, list);
  const draw = (q = '') => {
    list.innerHTML = '';
    for (const c of store.channels.filter((c) => c.kind !== 'voice' && (!q || c.name.includes(q.toLowerCase())))) {
      const r = el('div', 'picker-row', `<span class="ch-ico">#</span><span>${esc(c.name)}</span>`);
      r.onclick = async () => {
        dlg.close();
        try {
          await api.forward(m.id, c.id, crypto.randomUUID());
          toast('Forwarded to #' + c.name);
        } catch (e) { toast(e.message, 'error'); }
      };
      list.appendChild(r);
    }
  };
  const dlg = modal({ title: 'Forward message', body: box });
  search.oninput = () => draw(search.value);
  draw();
}

// ------------------------------------------------------------------ search
function parseQuery(raw) {
  const o = { query: '', channel: null, fromUser: null, has: null, before: null, after: null };
  const rest = [];
  for (const tok of (raw || '').split(/\s+/)) {
    const m = tok.match(/^(from|in|has|before|after):(.+)$/i);
    if (!m) { rest.push(tok); continue; }
    const [, k, v] = m;
    if (k.toLowerCase() === 'in') {
      const ch = store.channels.find((c) => c.name === v.replace(/^#/, ''));
      if (ch) o.channel = ch.id;
    } else if (k.toLowerCase() === 'from') {
      const p = [...store.profiles.values()].find((x) =>
        (x.username || '').toLowerCase() === v.replace(/^@/, '').toLowerCase() ||
        (x.display_name || '').toLowerCase() === v.replace(/^@/, '').toLowerCase());
      if (p) o.fromUser = p.id;
    } else if (k.toLowerCase() === 'has') o.has = v;
    else if (k.toLowerCase() === 'before') o.before = new Date(v).toISOString();
    else if (k.toLowerCase() === 'after') o.after = new Date(v).toISOString();
  }
  o.query = rest.join(' ').trim();
  return o;
}

registerPanel({
  id: 'search',
  title: 'Search',
  async render(body, ctx) {
    body.innerHTML = `
      <div class="search-box">
        <input id="searchInput" placeholder="Search messages" value="${esc(ctx.q || '')}" />
        <div class="muted search-hint">Try <code>from:@name</code> <code>in:#channel</code>
          <code>has:link</code> <code>before:2026-01-01</code></div>
      </div>
      <div id="searchResults"></div>`;
    const input = body.querySelector('#searchInput');
    const results = body.querySelector('#searchResults');
    const run = async () => {
      const parsed = parseQuery(input.value);
      if (!parsed.query && !parsed.fromUser && !parsed.channel) {
        results.innerHTML = '<div class="empty">Type something to search.</div>';
        return;
      }
      results.innerHTML = '<div class="muted pad">searching…</div>';
      try {
        const rows = await api.search({ ...parsed, workspace: store.ws.id, limit: 40 });
        if (!rows?.length) { results.innerHTML = '<div class="empty">No matches.</div>'; return; }
        results.innerHTML = '';
        for (const r of rows) {
          const ch = store.channels.find((c) => c.id === r.channel_id);
          const card = el('div', 'result');
          card.innerHTML = `<div class="muted">${avatarHtml(r.author_id, 18)} <b>${esc(nameOf(r.author_id))}</b>
            in #${esc(ch?.name || '?')} · ${esc(relTime(r.created_at))}</div>
            <div class="body">${fmt(r.body_text)}</div>`;
          card.onclick = () => {
            if (ch) openChannel(ch, { keepPanel: true, jumpSeq: r.seq });
          };
          results.appendChild(card);
        }
      } catch (e) { results.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    setTimeout(() => input.focus(), 30);
    if (ctx.q) run();
  },
});

// ------------------------------------------------------------------ pins
registerPanel({
  id: 'pins',
  title: 'Pinned',
  async render(body) {
    if (!store.current) { body.innerHTML = '<div class="empty">Open a channel first.</div>'; return; }
    const pins = await table('pins', (q) => q.eq('channel_id', store.current.id));
    if (!pins.length) { body.innerHTML = '<div class="empty">Nothing pinned in this channel yet.</div>'; return; }
    const ids = pins.map((p) => p.message_id);
    const msgs = await table('messages', (q) => q.in('id', ids));
    body.innerHTML = '';
    for (const m of msgs) {
      const card = el('div', 'result');
      card.appendChild(buildMessage(m, { context: 'static' }));
      const unpin = el('button', 'sm ghost', 'Unpin');
      unpin.onclick = async (e) => {
        e.stopPropagation();
        try { await api.unpin(m.id); card.remove(); } catch (err) { toast(err.message, 'error'); }
      };
      card.appendChild(unpin);
      card.onclick = () => jumpTo(m.id);
      body.appendChild(card);
    }
  },
});

// ------------------------------------------------------------------ members
registerPanel({
  id: 'members',
  title: 'Members',
  async render(body) {
    const rows = [...store.profiles.values()];
    body.innerHTML = `<input id="memSearch" placeholder="Search members" /><div id="memList"></div>`;
    const list = body.querySelector('#memList');
    const draw = (q = '') => {
      list.innerHTML = '';
      const filtered = rows.filter((p) => !q ||
        (p.display_name || '').toLowerCase().includes(q.toLowerCase()) ||
        (p.username || '').toLowerCase().includes(q.toLowerCase()));
      const on = filtered.filter((p) => store.online.has(p.id));
      const off = filtered.filter((p) => !store.online.has(p.id));
      const section = (title, arr) => {
        if (!arr.length) return;
        list.appendChild(el('h4', 'sec', `${esc(title)} — ${arr.length}`));
        for (const p of arr) {
          const r = el('div', 'member');
          r.innerHTML = `${avatarHtml(p.id, 28)}
            <div class="m-name">${esc(p.display_name || p.username || 'user')}
              ${p.status_emoji ? `<span>${esc(p.status_emoji)}</span>` : ''}
              ${p.status_text ? `<span class="muted">${esc(plain(p.status_text, 40))}</span>` : ''}</div>
            <span class="dot ${store.online.has(p.id) ? 'on' : 'off'}"></span>`;
          r.onclick = (ev) => bus.emit('profile:open', { userId: p.id, anchor: r, ev });
          list.appendChild(r);
        }
      };
      section('Online', on);
      section('Offline', off);
    };
    body.querySelector('#memSearch').oninput = (e) => draw(e.target.value);
    draw();
  },
});

// ------------------------------------------------------------------ activity
registerPanel({
  id: 'activity',
  title: 'Activity',
  async render(body) {
    body.innerHTML = '<div class="muted pad">loading…</div>';
    const [rows, err] = await tryRpc('get_activity', { p_workspace: store.ws.id, p_limit: 50 });
    if (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    if (!rows?.length) {
      body.innerHTML = '<div class="empty">Nothing yet. Mentions, reactions and thread replies land here.</div>';
      return;
    }
    body.innerHTML = '';
    for (const a of rows) {
      const ch = store.channels.find((c) => c.id === a.channel_id);
      const verb = a.kind === 'mention' ? 'mentioned you'
        : a.kind === 'reaction' ? 'reacted to your message' : 'replied in a thread';
      const card = el('div', 'result');
      card.innerHTML = `<div class="muted">${avatarHtml(a.actor_id, 18)}
        <b>${esc(nameOf(a.actor_id))}</b> ${esc(verb)} in #${esc(ch?.name || '?')} · ${esc(relTime(a.created_at))}</div>
        <div class="body">${fmt(plain(a.snippet, 160))}</div>`;
      card.onclick = () => { if (ch) openChannel(ch, { keepPanel: true }); };
      body.appendChild(card);
    }
  },
});

// ------------------------------------------------------------------ saved / later
registerPanel({
  id: 'saved',
  title: 'Saved & Later',
  async render(body) {
    body.innerHTML = '<div class="muted pad">loading…</div>';
    const [later] = await tryRpc('get_later', {});
    const [saved] = await tryRpc('list_saved', {});
    body.innerHTML = '';

    const section = (title, rows, renderRow) => {
      body.appendChild(el('h4', 'sec', esc(title)));
      if (!rows?.length) { body.appendChild(el('div', 'empty', 'Nothing here yet.')); return; }
      for (const r of rows) body.appendChild(renderRow(r));
    };

    section('Later', later, (r) => {
      const card = el('div', 'result');
      card.innerHTML = `<div class="muted">${esc(nameOf(r.author_id))} · ${esc(r.state || 'todo')}</div>
        <div class="body">${fmt(plain(r.body_text, 160))}</div>`;
      const bar = el('div', 'row gap');
      for (const s of ['todo', 'in_progress', 'done']) {
        const b = el('button', 'sm ghost' + (r.state === s ? ' on' : ''), s.replace('_', ' '));
        b.onclick = async (e) => {
          e.stopPropagation();
          try { await api.laterSetState(r.message_id, s); openPanel('saved'); }
          catch (err) { toast(err.message, 'error'); }
        };
        bar.appendChild(b);
      }
      const rm = el('button', 'sm ghost', 'Remove');
      rm.onclick = async (e) => {
        e.stopPropagation();
        await api.laterRemove(r.message_id).catch(() => {});
        openPanel('saved');
      };
      bar.appendChild(rm);
      card.appendChild(bar);
      return card;
    });

    section('Bookmarked messages', saved, (r) => {
      const card = el('div', 'result');
      card.innerHTML = `<div class="muted">${esc(r.author_name || nameOf(r.author_id))} in #${esc(r.channel_name || '')}</div>
        <div class="body">${fmt(plain(r.body_text, 160))}</div>`;
      card.onclick = () => {
        const ch = store.channels.find((c) => c.id === r.channel_id);
        if (ch) openChannel(ch, { keepPanel: true });
      };
      return card;
    });
  },
});

// ------------------------------------------------------------------ header
export function registerCoreHeader() {
  addHeaderButton({ id: 'threads', label: icon('thread'), title: 'Threads', order: 10, onClick: () => openPanel('threads-list') });
  addHeaderButton({ id: 'activity', label: icon('bell'), title: 'Activity', order: 20, onClick: () => openPanel('activity') });
  addHeaderButton({ id: 'saved', label: icon('bookmark'), title: 'Saved and Later', order: 30, onClick: () => openPanel('saved') });
  addHeaderButton({ id: 'search', label: icon('search'), title: 'Search (Ctrl+K)', order: 40, onClick: () => openPanel('search', {}) });
  addHeaderButton({ id: 'pins', label: icon('pin'), title: 'Pinned', order: 50, onClick: () => openPanel('pins') });
  addHeaderButton({ id: 'members', label: icon('members'), title: 'Members', order: 60, onClick: () => openPanel('members') });

  addSwitcherSource({
    id: 'channels',
    search: (q) => store.channels
      .filter((c) => !q || c.name.includes(q.toLowerCase()))
      .slice(0, 8)
      .map((c) => ({ label: '#' + c.name, hint: c.topic || '', icon: c.kind === 'voice' ? '🔊' : '#',
        run: () => (c.kind === 'voice' ? bus.emit('voice:join', { channelId: c.id }) : openChannel(c)) })),
  });
  addSwitcherSource({
    id: 'people',
    search: (q) => [...store.profiles.values()]
      .filter((p) => p.id !== store.me)
      .filter((p) => !q || (p.display_name || '').toLowerCase().includes(q.toLowerCase()))
      .slice(0, 6)
      .map((p) => ({ label: p.display_name || p.username, hint: 'Direct message', icon: '@',
        run: () => startDM(p.id) })),
  });
}

// ------------------------------------------------------------------ profile card
bus.on('profile:open', async ({ userId, anchor }) => {
  if (!userId) return;
  const p = store.profiles.get(userId) || {};
  const box = el('div', 'profile-card');
  box.innerHTML = `
    <div class="pc-head">${avatarHtml(userId, 56)}
      <div><b>${esc(p.display_name || p.username || 'user')}</b>
      ${p.username ? `<div class="muted">@${esc(p.username)}</div>` : ''}
      ${p.pronouns ? `<div class="muted">${esc(p.pronouns)}</div>` : ''}</div></div>
    <div id="pcStatus" class="muted"></div>
    <div class="pc-actions">
      ${userId !== store.me ? '<button class="sm" data-a="dm">Message</button>' : ''}
      ${userId !== store.me && hasPerm(PERM.KICK) ? '<button class="sm ghost" data-a="kick">Remove</button>' : ''}
      ${userId !== store.me && hasPerm(PERM.BAN) ? '<button class="sm danger" data-a="ban">Ban</button>' : ''}
    </div>`;
  const m = modal({ title: '', body: box });
  box.querySelector('[data-a="dm"]')?.addEventListener('click', () => { m.close(); startDM(userId); });
  box.querySelector('[data-a="kick"]')?.addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Remove member', body: 'They lose access immediately.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.kick(store.ws.id, userId); m.close(); toast('Removed'); } catch (e) { toast(e.message, 'error'); }
  });
  box.querySelector('[data-a="ban"]')?.addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Ban member', body: 'They cannot rejoin with any invite.', confirmLabel: 'Ban', danger: true }))) return;
    try { await api.ban(store.ws.id, userId, null); m.close(); toast('Banned'); } catch (e) { toast(e.message, 'error'); }
  });

  const [card] = await tryRpc('get_profile_card', { p_user: userId });
  if (card) {
    box.querySelector('#pcStatus').innerHTML = `
      ${card.status_emoji || ''} ${esc(card.status_text || '')}
      ${card.online ? '<span class="dot on"></span> online' : '<span class="dot off"></span> offline'}
      ${card.dnd ? ' · do not disturb' : ''}
      ${(card.roles || []).map((r) => `<span class="rolechip">${esc(r.name)}</span>`).join('')}`;
  }
});
