// Workspace (Space) lifecycle: the left rail of orgs, one-call bootstrap, and
// invite links. Hearth is multi-org: an admin shares one link and the person who
// opens it lands in exactly that Space.
import { api, table, tryRpc } from '../api.js';
import { sb, subscribe } from '../sb.js';
import { store, bus } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, initials, hueOf } from '../util.js';
import { toast, formModal, modal, confirmModal, renderHeaderButtons } from '../ui.js';
import { renderChannels, openChannel, refreshUnread, lastChannelId } from './channels.js';

// ------------------------------------------------------------------ rail
export function renderSpaceRail() {
  const r = $('spaceRail');
  if (!r) return;
  let h = '';
  for (const s of store.spaces) {
    const b = store.spaceBadges.get(s.id);
    const active = store.ws?.id === s.id;
    h += `<div class="sicon${active ? ' active' : ''}" data-ws="${s.id}" title="${esc(s.name || '')}"
      style="--h:${hueOf(s.id)}">${esc(initials(s.name))}
      ${b?.mention_total ? `<span class="sbadge">${b.mention_total}</span>`
        : b?.unread_total ? '<span class="sdot"></span>' : ''}</div>`;
  }
  h += `<div class="sicon add" data-add="1" title="Create or join a Space">+</div>`;
  r.innerHTML = h;
  r.querySelectorAll('[data-ws]').forEach((n) => {
    n.onclick = () => {
      const s = store.spaces.find((x) => x.id === n.dataset.ws);
      if (s && s.id !== store.ws?.id) switchWorkspace(s);
    };
    n.oncontextmenu = (e) => { e.preventDefault(); spaceMenu(e, store.spaces.find((x) => x.id === n.dataset.ws)); };
  });
  r.querySelector('[data-add]').onclick = spaceChooser;
}

function spaceMenu(ev, s) {
  if (!s) return;
  import('../ui.js').then(({ contextMenu }) => contextMenu(ev, [
    { label: 'Invite people', onClick: () => inviteDialog(s) },
    { label: 'Copy invite link', onClick: () => copyInvite(s) },
    '-',
    { label: 'Leave Space', danger: true, onClick: async () => {
      if (!(await confirmModal({ title: 'Leave ' + s.name, body: 'You will need a new invite link to come back.', confirmLabel: 'Leave', danger: true }))) return;
      try {
        await api.leaveWorkspace(s.id);
        toast('Left ' + s.name);
        await loadSpaces();
        if (store.spaces[0]) await switchWorkspace(store.spaces[0]);
      } catch (e) { toast(e.message, 'error'); }
    } },
  ]));
}

// ------------------------------------------------------------------ load
export async function loadSpaces() {
  const rows = await table('workspaces', (q) => q.order('created_at'));
  store.spaces = rows;
  const [summary] = await tryRpc('get_space_summary', {});
  if (Array.isArray(summary)) {
    store.spaceBadges = new Map(summary.map((s) => [s.workspace_id, s]));
  }
  renderSpaceRail();
  return rows;
}

// One round trip for the whole workspace. Falls back to individual queries when
// the consolidated RPC is unavailable, so the client never hard-depends on it.
export async function switchWorkspace(target) {
  if (!target) return;
  store.ws = target;
  store.current = null;
  store.currentDM = null;
  $('spaceName').textContent = target.name || '';
  renderSpaceRail();

  const [boot] = await tryRpc('get_bootstrap', { p_workspace: target.id });
  if (boot && boot.channels) {
    store.categories = boot.categories || [];
    store.channels = boot.channels || [];
    store.dms = boot.dms || [];
    store.profiles = new Map((boot.members || []).map((m) => [m.user_id, { id: m.user_id, ...m }]));
    store.online = new Set((boot.members || []).filter((m) => m.online).map((m) => m.user_id));
    store.unread = new Map((boot.unread || []).map((u) => [u.scope_id, u]));
    store.notify = new Map((boot.notify || []).map((n) => [n.scope_id, n]));
    store.drafts = new Map((boot.drafts || []).map((d) => [d.scope_type + ':' + d.scope_id, d.body_text]));
    store.voiceParts = new Map();
    for (const v of boot.voice || []) {
      if (!store.voiceParts.has(v.channel_id)) store.voiceParts.set(v.channel_id, []);
      store.voiceParts.get(v.channel_id).push(v.user_id);
    }
    store.perms = BigInt(boot.me?.permissions ?? 0);
    store.isAdmin = !!boot.me?.is_admin || (store.perms & PERM.ADMINISTRATOR) !== 0n;
    if (boot.me) store.myProfile = { id: store.me, ...boot.me };
  } else {
    await legacyLoad(target);
  }

  bus.emit('workspace', { ws: target });
  renderHeaderButtons();
  await renderChannels();
  subscribeWorkspace(target);

  // Open where they left off. Two reasons, and the second is the important one:
  // going back to the conversation you were in is what every other chat app
  // does, and the cold-start paint has ALREADY drawn that channel from this
  // phone's storage - opening a different one instead would swap the screen out
  // from under the person a few seconds after showing it to them.
  const lastId = lastChannelId();
  const first = store.channels.find((c) => c.id === lastId && c.kind !== 'voice' && !c.archived_at)
    || store.channels.find((c) => c.name === 'general' && c.kind !== 'voice')
    || store.channels.find((c) => c.kind !== 'voice' && !c.archived_at);
  if (first) await openChannel(first);
  else $('messages').innerHTML = '<div class="empty">No channels here yet.</div>';
}

// Pre-0047 path: individual queries. Kept so a stale deploy still works.
async function legacyLoad(target) {
  const [cats, chans, mem] = await Promise.all([
    table('categories', (q) => q.eq('workspace_id', target.id).order('position')),
    table('channels', (q) => q.eq('workspace_id', target.id).order('position')),
    table('workspace_members', (q) => q.eq('workspace_id', target.id)),
  ]);
  store.categories = cats;
  store.channels = chans;
  const ids = mem.map((m) => m.user_id);
  if (ids.length) {
    const profs = await table('profiles', (q) => q.in('id', ids));
    store.profiles = new Map(profs.map((p) => [p.id, p]));
  }
  const convs = await table('conversations', (q) => q.eq('workspace_id', target.id));
  const convIds = convs.map((c) => c.id);
  const cmem = convIds.length ? await table('conversation_members', (q) => q.in('conversation_id', convIds)) : [];
  store.dms = convs.map((c) => ({
    conversation_id: c.id, kind: c.kind,
    other_user_ids: cmem.filter((m) => m.conversation_id === c.id).map((m) => m.user_id),
    last_message_at: c.last_message_at, unread: 0,
  }));
  const [unread] = await tryRpc('get_unread', { p_workspace: target.id });
  store.unread = new Map((unread || []).map((u) => [u.scope_id, u]));
  const [notif] = await tryRpc('get_notify_settings', { p_workspace: target.id });
  store.notify = new Map((notif?.channels || []).map((n) => [n.scope_id, n]));
  store.myProfile = store.profiles.get(store.me) || store.myProfile;
  store.perms = 0n;
  store.isAdmin = false;
}

function subscribeWorkspace(ws) {
  subscribe('ws', 'ws:' + ws.id, {
    channel_created: () => bus.emit('channels:reload'),
    channel_updated: () => bus.emit('channels:reload'),
    channel_deleted: () => bus.emit('channels:reload'),
    // The payload carries the profile, so one person joining a 300-member Space
    // costs every other client zero queries instead of one each.
    member_joined: (p) => {
      if (!p?.user_id) { reloadMembers(); return; }
      store.profiles.set(p.user_id, {
        id: p.user_id, display_name: p.display_name, username: p.username,
        avatar_key: p.avatar_key, status_text: p.status_text,
        status_emoji: p.status_emoji, member_type: p.member_type,
      });
      bus.emit('profiles');
    },
    member_left: (p) => {
      if (p?.user_id) store.profiles.delete(p.user_id);
      bus.emit('profiles');
    },
  });
}

export async function reloadMembers() {
  if (!store.ws) return;
  const mem = await table('workspace_members', (q) => q.eq('workspace_id', store.ws.id));
  const ids = mem.map((m) => m.user_id);
  if (!ids.length) return;
  const profs = await table('profiles', (q) => q.in('id', ids));
  for (const p of profs) store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
  bus.emit('profiles');
}

export async function reloadChannels(openId) {
  if (!store.ws) return;
  const [boot] = await tryRpc('get_bootstrap', { p_workspace: store.ws.id });
  if (boot?.channels) {
    store.categories = boot.categories || [];
    store.channels = boot.channels || [];
  } else {
    store.channels = await table('channels', (q) => q.eq('workspace_id', store.ws.id).order('position'));
    store.categories = await table('categories', (q) => q.eq('workspace_id', store.ws.id).order('position'));
  }
  await renderChannels();
  if (openId) {
    const c = store.channels.find((x) => x.id === openId);
    if (c) openChannel(c);
  }
}

// ------------------------------------------------------------------ create / join
export async function spaceChooser() {
  const box = el('div', 'chooser');
  box.innerHTML = `
    <button class="chooser-card" data-a="create">
      <div class="cc-ico">🏗️</div><div><b>Create a Space</b>
      <div class="muted">Start a new organization. You become its admin and get an invite link to share.</div></div>
    </button>
    <button class="chooser-card" data-a="join">
      <div class="cc-ico">🔗</div><div><b>Join with a link</b>
      <div class="muted">Someone sent you an invite link or code? Paste it here.</div></div>
    </button>`;
  const m = modal({ title: 'Spaces', body: box });
  box.querySelector('[data-a="create"]').onclick = () => { m.close(); createSpaceDialog(); };
  box.querySelector('[data-a="join"]').onclick = () => { m.close(); joinDialog(); };
}

export async function createSpaceDialog() {
  const out = await formModal({
    title: 'Create a Space',
    note: 'A Space is your organization. Channels, members and roles all live inside it.',
    fields: [{ name: 'name', label: 'Space name', required: true, placeholder: 'Acme Inc' }],
    submitLabel: 'Create Space',
  });
  if (!out) return;
  try {
    const data = await api.createSpace(out.name.trim());
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === data.id) || data;
    await switchWorkspace(s);
    toast('Space created');
    await inviteDialog(s, true);
  } catch (e) { toast(e.message, 'error'); }
}

export async function joinDialog() {
  const out = await formModal({
    title: 'Join a Space',
    fields: [{ name: 'link', label: 'Invite link or code', required: true,
      placeholder: 'https://…/#/join/abc123  or just abc123' }],
    submitLabel: 'Join',
  });
  if (!out) return;
  const token = extractToken(out.link.trim());
  try {
    const wsRow = await api.redeemInvite(token);
    await loadSpaces();
    const s = store.spaces.find((x) => x.id === wsRow.id) || wsRow;
    await switchWorkspace(s);
    toast('Joined ' + (s.name || 'the Space'));
  } catch (e) { toast(e.message || 'That invite did not work', 'error'); }
}

export const extractToken = (s) => {
  const m = (s || '').match(/join\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]) : (s || '').trim();
};

export function inviteLinkFor(token) {
  return location.origin + location.pathname + '#/join/' + token;
}

export async function copyInvite(space) {
  const ws = space || store.ws;
  if (!ws) return;
  try {
    const token = await api.createInvite(ws.id, null, null, null);
    const link = inviteLinkFor(token);
    await navigator.clipboard?.writeText(link);
    toast('Invite link copied');
    return link;
  } catch (e) { toast(e.message, 'error'); }
}

export async function inviteDialog(space, isNew = false) {
  const ws = space || store.ws;
  if (!ws) return;
  const box = el('div', 'invite-box');
  box.innerHTML = `
    ${isNew ? `<p class="muted">Your Space <b>${esc(ws.name)}</b> is live. Share this link and anyone who opens it lands right here.</p>` : ''}
    <div class="invite-row"><input id="inviteLink" readonly value="generating…" />
      <button id="copyInvite">Copy</button></div>
    <div class="invite-opts">
      <label class="field"><span class="field-label">Expires</span>
        <select id="invExp">
          <option value="">Never</option><option value="1">1 day</option>
          <option value="7">7 days</option><option value="30">30 days</option></select></label>
      <label class="field"><span class="field-label">Max uses</span>
        <input id="invMax" type="number" min="1" placeholder="Unlimited" /></label>
      <button class="ghost" id="regen">Generate new link</button>
    </div>
    <div id="inviteList" class="invite-list"></div>`;
  const m = modal({ title: 'Invite to ' + ws.name, body: box, wide: true });

  const make = async () => {
    const days = box.querySelector('#invExp').value;
    const max = box.querySelector('#invMax').value;
    try {
      const token = await api.createInvite(
        ws.id, max ? +max : null,
        days ? new Date(Date.now() + +days * 86400000).toISOString() : null, null);
      box.querySelector('#inviteLink').value = inviteLinkFor(token);
      refreshList();
    } catch (e) { box.querySelector('#inviteLink').value = e.message; }
  };
  const refreshList = async () => {
    const [rows] = await tryRpc('list_invites', { p_workspace: ws.id });
    const host = box.querySelector('#inviteList');
    if (!Array.isArray(rows) || !rows.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="muted" style="margin:10px 0 4px">Active invites</div>' + rows
      .filter((r) => !r.revoked_at)
      .map((r) => `<div class="inv-row"><span>${r.uses || 0}${r.max_uses ? '/' + r.max_uses : ''} uses</span>
        <span class="muted">${r.expires_at ? 'expires ' + new Date(r.expires_at).toLocaleDateString() : 'never expires'}</span>
        <button class="icon" data-rev="${r.id}">Revoke</button></div>`).join('');
    host.querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = async () => { await api.revokeInvite(b.dataset.rev).catch(() => {}); refreshList(); };
    });
  };

  box.querySelector('#copyInvite').onclick = async () => {
    await navigator.clipboard?.writeText(box.querySelector('#inviteLink').value);
    toast('Copied');
  };
  box.querySelector('#regen').onclick = make;
  await make();
}

bus.on('channels:reload', (p) => reloadChannels(p?.open));
bus.on('spaces:badges', renderSpaceRail);
