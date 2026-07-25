// The admin console: one wide side panel over the five admin_* reads, with the
// destructive moves kept behind ui.confirmModal.
//
// Two decisions worth knowing about:
//  - Tab data is fetched once and held for the life of the open panel. Flipping
//    Members -> Audit -> Members must not re-hit the server; only an action that
//    actually changed something invalidates its slice of the cache.
//  - The panel is widened with a `:has(.admin-root)` rule injected from here, so
//    nothing in styles.css has to know this feature exists and the width falls
//    back the instant another panel takes over the aside.
import { api, table } from '../api.js';
import { store, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, relTime, plain } from '../util.js';
import { icon } from '../icons.js';

const canAdmin = () => hasPerm(PERM.MANAGE_WORKSPACE) || store.isAdmin;

const CSS = `
@media (min-width:861px){ aside#panel:has(.admin-root){width:min(780px,64vw)} }
.admin-root{display:flex;flex-direction:column;gap:10px}
.admin-tabs{display:flex;gap:4px;flex-wrap:wrap;position:sticky;top:-10px;background:var(--panel);
  padding:2px 0 6px;z-index:2;border-bottom:1px solid var(--line)}
.admin-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.admin-stat{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px}
.admin-stat b{display:block;font-size:26px;line-height:1.15;letter-spacing:-.5px}
.admin-stat span{font-size:12px}
.admin-scroll{overflow-x:auto}
.admin-table{width:100%;border-collapse:collapse;font-size:13px}
.admin-table th{text-align:left;font-size:10.5px;text-transform:uppercase;color:var(--faint);
  letter-spacing:.6px;padding:5px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
.admin-table td{padding:6px;border-bottom:1px solid var(--line);vertical-align:middle}
.admin-table tr:hover td{background:var(--panel2)}
.admin-acts{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.admin-nowrap{white-space:nowrap}
.admin-line{display:flex;gap:8px;align-items:baseline;padding:7px 4px;border-bottom:1px solid var(--line);font-size:13px}
.admin-line .admin-when{margin-left:auto;color:var(--faint);font-size:11.5px;white-space:nowrap}
.admin-form{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px}
.admin-form .row.gap{align-items:flex-end;flex-wrap:wrap}
.admin-form .field{margin-bottom:0;min-width:130px;flex:1}
.admin-linkrow{display:flex;gap:8px;margin-top:10px}
`;

function injectCss() {
  if (document.getElementById('admin-feature-css')) return;
  const s = document.createElement('style');
  s.id = 'admin-feature-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// A member who was banned is deleted from workspace_members, so nameOf() has
// nothing to work with. Fall back to a short id rather than printing "someone".
const memberName = (id) =>
  store.profiles.get(id)?.display_name || store.profiles.get(id)?.username || 'user ' + String(id || '').slice(0, 8);

const num = (v) => Number(v || 0).toLocaleString();
const inviteLinkFor = (token) => location.origin + location.pathname + '#/join/' + token;

async function cached(ctx, key, fetcher) {
  if (!ctx.cache.has(key)) ctx.cache.set(key, await fetcher());
  return ctx.cache.get(key);
}

// ------------------------------------------------------------------ overview
async function drawOverview(host, ctx, { ui }) {
  const s = await cached(ctx, 'stats', () => api.adminStats(store.ws.id));
  host.innerHTML = '';
  const grid = el('div', 'admin-stats');
  const cards = [
    ['Members', s?.member_count],
    ['Channels', s?.channel_count],
    ['Messages, last 7 days', s?.message_count_7d],
  ];
  for (const [label, v] of cards) {
    grid.appendChild(el('div', 'admin-stat', `<b>${esc(num(v))}</b><span class="muted">${esc(label)}</span>`));
  }
  host.appendChild(grid);

  host.appendChild(el('h4', 'sec', 'Space settings'));
  const ws = store.ws;
  const gateBox = el('div', 'admin-form');
  const levels = ['Anyone with a link', 'Verified email required', 'Verified email, aged account'];
  gateBox.innerHTML = `<div class="muted">Who can join: <b>${esc(levels[ws.verification_level || 0] || 'custom')}</b>
    ${ws.requires_approval ? ' · new members need approval' : ' · no approval needed'}</div>
    ${ws.rules_text ? `<div class="muted" style="margin-top:6px">Rules: ${esc(plain(ws.rules_text, 140))}</div>` : ''}`;
  const editGate = el('button', 'sm ghost', 'Edit joining rules');
  editGate.style.marginTop = '10px';
  editGate.onclick = async () => {
    const out = await ui.formModal({
      title: 'Who can join this Space',
      fields: [
        { name: 'level', label: 'Verification', type: 'select', value: String(ws.verification_level || 0),
          options: levels.map((l, i) => ({ value: String(i), label: l })) },
        { name: 'approval', label: 'New members need an admin to approve them', type: 'checkbox', value: !!ws.requires_approval },
        { name: 'rules', label: 'Rules shown before joining', type: 'textarea', rows: 4, value: ws.rules_text || '' },
      ],
      submitLabel: 'Save',
    });
    if (!out) return;
    try {
      await api.setWorkspaceGate(store.ws.id, Number(out.level), !!out.approval, out.rules || null);
      // Keep the local row honest so the panel does not lie until the next reload.
      ws.verification_level = Number(out.level);
      ws.requires_approval = !!out.approval;
      ws.rules_text = out.rules || null;
      ui.toast('Joining rules saved', 'success');
      ctx.redraw();
    } catch (e) { ui.toast(e.message, 'error'); }
  };
  gateBox.appendChild(editGate);
  host.appendChild(gateBox);

  const leave = el('button', 'sm danger', 'Leave this Space');
  leave.onclick = async () => {
    if (!(await ui.confirmModal({
      title: 'Leave ' + (ws.name || 'this Space'),
      body: 'You lose access immediately and need a fresh invite link to come back.',
      confirmLabel: 'Leave', danger: true,
    }))) return;
    try { await api.leaveWorkspace(ws.id); location.reload(); }
    catch (e) { ui.toast(e.message, 'error'); }
  };
  host.appendChild(leave);
}

// ------------------------------------------------------------------ members
async function drawMembers(host, ctx, { ui }) {
  const rows = await cached(ctx, 'members', () => api.adminMembers(store.ws.id));
  const bans = hasPerm(PERM.BAN)
    ? await cached(ctx, 'bans', () => table('bans', (q) => q.eq('workspace_id', store.ws.id)))
    : [];
  host.innerHTML = '';

  if (!rows?.length) {
    host.appendChild(el('div', 'empty', 'Nobody here yet. People show up in this table the moment they redeem an invite link.'));
  } else {
    const search = el('input');
    search.placeholder = `Search ${rows.length} members`;
    const scroll = el('div', 'admin-scroll');
    host.append(search, scroll);

    const draw = (q = '') => {
      const needle = q.trim().toLowerCase();
      const list = rows.filter((r) => !needle || (r.display_name || '').toLowerCase().includes(needle));
      scroll.innerHTML = '';
      if (!list.length) { scroll.appendChild(el('div', 'empty', 'No member matches that search.')); return; }
      const t = el('table', 'admin-table');
      t.innerHTML = `<thead><tr><th>Name</th><th>Joined</th><th>Type</th><th>Roles</th><th></th><th></th></tr></thead>`;
      const tb = el('tbody');
      for (const r of list) {
        const timedOut = r.timeout_until && new Date(r.timeout_until) > new Date();
        const tr = el('tr');
        tr.innerHTML = `
          <td><b>${esc(r.display_name || memberName(r.user_id))}</b>
            ${timedOut ? `<span class="rolechip">muted until ${esc(new Date(r.timeout_until).toLocaleString())}</span>` : ''}</td>
          <td class="muted admin-nowrap">${esc(r.joined_at ? relTime(r.joined_at) : '-')}</td>
          <td class="muted">${esc(r.member_type || 'member')}</td>
          <td>${(r.roles || []).map((n) => `<span class="rolechip">${esc(n)}</span>`).join('') || '<span class="muted">-</span>'}</td>
          <td><span class="dot ${store.online.has(r.user_id) ? 'on' : 'off'}"></span></td>`;
        const acts = el('td');
        const bar = el('div', 'admin-acts');
        if (r.user_id !== store.me) {
          if (hasPerm(PERM.MODERATE)) bar.appendChild(actionBtn('Timeout', 'sm ghost', () => timeoutDialog(r, ctx, ui)));
          if (hasPerm(PERM.KICK)) bar.appendChild(actionBtn('Kick', 'sm ghost', () => kick(r, ctx, ui)));
          if (hasPerm(PERM.BAN)) bar.appendChild(actionBtn('Ban', 'sm danger', () => ban(r, ctx, ui)));
        } else {
          bar.appendChild(el('span', 'muted', 'you'));
        }
        acts.appendChild(bar);
        tr.appendChild(acts);
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      scroll.appendChild(t);
    };
    search.oninput = () => draw(search.value);
    draw();
  }

  if (hasPerm(PERM.BAN)) {
    host.appendChild(el('h4', 'sec', 'Banned'));
    if (!bans.length) {
      host.appendChild(el('div', 'empty', 'Nobody is banned. Banned people are removed from the Space and cannot redeem any invite.'));
    } else {
      for (const b of bans) {
        const row = el('div', 'admin-line');
        row.innerHTML = `<b>${esc(memberName(b.user_id))}</b>
          <span class="muted">${esc(b.reason || 'no reason given')}</span>
          <span class="admin-when">${esc(b.created_at ? relTime(b.created_at) : '')}</span>`;
        const un = el('button', 'sm ghost', 'Unban');
        un.onclick = async () => {
          try {
            await api.unban(store.ws.id, b.user_id);
            ui.toast('Ban lifted', 'success');
            ctx.cache.delete('bans');
            ctx.cache.delete('members');
            ctx.redraw();
          } catch (e) { ui.toast(e.message, 'error'); }
        };
        row.appendChild(un);
        host.appendChild(row);
      }
    }
  }
}

function actionBtn(label, cls, onClick) {
  const b = el('button', cls, esc(label));
  b.onclick = onClick;
  return b;
}

async function timeoutDialog(r, ctx, ui) {
  const out = await ui.formModal({
    title: 'Timeout ' + (r.display_name || 'member'),
    note: 'A timeout stops them posting anywhere in this Space until it expires.',
    fields: [{ name: 'dur', label: 'For how long', type: 'select', options: [
      { value: '5', label: '5 minutes' }, { value: '60', label: '1 hour' },
      { value: '1440', label: '1 day' }, { value: '10080', label: '1 week' },
      { value: '0', label: 'Clear the timeout' },
    ] }],
    submitLabel: 'Apply',
  });
  if (!out) return;
  const mins = Number(out.dur);
  try {
    await api.timeout(store.ws.id, r.user_id, mins ? new Date(Date.now() + mins * 60000).toISOString() : null);
    ui.toast(mins ? 'Timeout applied' : 'Timeout cleared', 'success');
    ctx.cache.delete('members');
    ctx.redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

async function kick(r, ctx, ui) {
  if (!(await ui.confirmModal({
    title: 'Remove ' + (r.display_name || 'member'),
    body: 'They lose access straight away but can rejoin with a valid invite.',
    confirmLabel: 'Remove', danger: true,
  }))) return;
  try {
    await api.kick(store.ws.id, r.user_id);
    ui.toast('Removed', 'success');
    ctx.cache.delete('members');
    ctx.cache.delete('stats');
    ctx.redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

async function ban(r, ctx, ui) {
  if (!(await ui.confirmModal({
    title: 'Ban ' + (r.display_name || 'member'),
    body: 'They are removed and no invite link will let them back in.',
    confirmLabel: 'Ban', danger: true,
  }))) return;
  try {
    await api.ban(store.ws.id, r.user_id, null);
    ui.toast('Banned', 'success');
    ctx.cache.delete('members');
    ctx.cache.delete('bans');
    ctx.cache.delete('stats');
    ctx.redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ channels
async function drawChannels(host, ctx, { ui }) {
  const rows = await cached(ctx, 'channels', () => api.adminChannels(store.ws.id));
  host.innerHTML = '';
  if (!rows?.length) {
    host.appendChild(el('div', 'empty', 'No channels in this Space yet. Create one from the + next to a category in the sidebar.'));
    return;
  }
  const scroll = el('div', 'admin-scroll');
  const t = el('table', 'admin-table');
  t.innerHTML = `<thead><tr><th>Channel</th><th>Kind</th><th>Access</th><th>Messages</th><th>Last post</th><th></th></tr></thead>`;
  const tb = el('tbody');
  for (const c of rows) {
    const tr = el('tr');
    tr.innerHTML = `
      <td><b>${esc((c.kind === 'voice' ? '🔊 ' : '# ') + c.name)}</b>
        ${c.archived_at ? '<span class="rolechip">archived</span>' : ''}
        ${c.topic ? `<div class="muted">${esc(plain(c.topic, 60))}</div>` : ''}</td>
      <td class="muted">${esc(c.kind || 'text')}</td>
      <td class="muted">${c.is_private ? 'private' : 'open'}</td>
      <td class="muted admin-nowrap">${esc(c.message_count == null ? '-' : num(c.message_count))}</td>
      <td class="muted admin-nowrap">${esc(c.last_message_at ? relTime(c.last_message_at) : 'never')}</td>`;
    const acts = el('td');
    const bar = el('div', 'admin-acts');
    if (hasPerm(PERM.MANAGE_CHANNELS)) {
      bar.appendChild(actionBtn('Edit', 'sm ghost', () => editChannel(c, ctx, ui)));
      bar.appendChild(actionBtn(c.archived_at ? 'Unarchive' : 'Archive', 'sm ghost', () => archive(c, ctx, ui)));
      bar.appendChild(actionBtn('Delete', 'sm danger', () => delChannel(c, ctx, ui)));
    } else {
      bar.appendChild(el('span', 'muted', 'read only'));
    }
    acts.appendChild(bar);
    tr.appendChild(acts);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  scroll.appendChild(t);
  host.appendChild(scroll);
}

async function editChannel(c, ctx, ui) {
  const out = await ui.formModal({
    title: 'Edit #' + c.name,
    fields: [
      { name: 'name', label: 'Name', value: c.name, required: true },
      { name: 'topic', label: 'Topic', type: 'textarea', rows: 3, value: c.topic || '' },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;
  try {
    await api.updateChannel(c.channel_id, { name: out.name.trim(), topic: out.topic || null });
    ui.toast('Channel updated', 'success');
    ctx.cache.delete('channels');
    ctx.redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

async function archive(c, ctx, ui) {
  const on = !c.archived_at;
  if (on && !(await ui.confirmModal({
    title: 'Archive #' + c.name,
    body: 'The channel stays readable but nobody can post in it.',
    confirmLabel: 'Archive',
  }))) return;
  try {
    await api.archiveChannel(c.channel_id, on);
    ui.toast(on ? 'Archived' : 'Unarchived', 'success');
    ctx.cache.delete('channels');
    ctx.cache.delete('stats');
    ctx.redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

async function delChannel(c, ctx, ui) {
  if (!(await ui.confirmModal({
    title: 'Delete #' + c.name,
    body: 'Every message in it goes too. This cannot be undone - archive it instead if you are unsure.',
    confirmLabel: 'Delete forever', danger: true,
  }))) return;
  try {
    await api.deleteChannel(c.channel_id);
    ui.toast('Channel deleted', 'success');
    ctx.cache.delete('channels');
    ctx.cache.delete('stats');
    ctx.redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ invites
async function drawInvites(host, ctx, { ui }) {
  const rows = await cached(ctx, 'invites', () => api.listInvites(store.ws.id));
  host.innerHTML = '';
  const listHost = el('div');

  if (hasPerm(PERM.CREATE_INVITE)) {
    const form = el('div', 'admin-form');
    form.innerHTML = `
      <div class="row gap">
        <label class="field"><span class="field-label">Expires</span>
          <select id="admInvExp"><option value="">Never</option><option value="1">1 day</option>
            <option value="7">7 days</option><option value="30">30 days</option></select></label>
        <label class="field"><span class="field-label">Max uses</span>
          <input id="admInvMax" type="number" min="1" placeholder="Unlimited" /></label>
        <button id="admInvMake">Create invite</button>
      </div>
      <div class="admin-linkrow hidden" id="admInvOut">
        <input id="admInvLink" readonly /><button class="ghost" id="admInvCopy">Copy</button></div>`;
    host.appendChild(form);
    form.querySelector('#admInvMake').onclick = async () => {
      const days = form.querySelector('#admInvExp').value;
      const max = form.querySelector('#admInvMax').value;
      try {
        const token = await api.createInvite(
          store.ws.id, max ? Number(max) : null,
          days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null, null);
        form.querySelector('#admInvOut').classList.remove('hidden');
        form.querySelector('#admInvLink').value = inviteLinkFor(token);
        ui.toast('Invite created', 'success');
        ctx.cache.delete('invites');
        // Redraw the list underneath without losing the link we just minted.
        const fresh = await api.listInvites(store.ws.id);
        ctx.cache.set('invites', fresh);
        drawInviteList(listHost, fresh, ctx, ui);
      } catch (e) { ui.toast(e.message, 'error'); }
    };
    form.querySelector('#admInvCopy').onclick = async () => {
      await navigator.clipboard?.writeText(form.querySelector('#admInvLink').value).catch(() => {});
      ui.toast('Invite link copied');
    };
  }

  host.appendChild(listHost);
  drawInviteList(listHost, rows, ctx, ui);
}

function drawInviteList(hostEl, rows, ctx, ui) {
  hostEl.innerHTML = '';
  const live = (rows || []).filter((r) => !r.revoked_at);
  hostEl.appendChild(el('h4', 'sec', `Active invites${live.length ? ' - ' + live.length : ''}`));
  if (!live.length) {
    hostEl.appendChild(el('div', 'empty', 'No live invite links. Create one above and share it - whoever opens it lands straight in this Space.'));
    return;
  }
  for (const r of live) {
    const expired = r.expires_at && new Date(r.expires_at) < new Date();
    const row = el('div', 'admin-line');
    row.innerHTML = `<b>${esc(num(r.uses))}${r.max_uses ? ' / ' + esc(num(r.max_uses)) : ''} uses</b>
      <span class="muted">by ${esc(memberName(r.created_by))}</span>
      <span class="muted">${esc(r.expires_at
        ? (expired ? 'expired ' : 'expires ') + new Date(r.expires_at).toLocaleDateString()
        : 'never expires')}</span>
      <span class="admin-when">${esc(r.created_at ? relTime(r.created_at) : '')}</span>`;
    const rev = el('button', 'sm ghost', 'Revoke');
    rev.onclick = async () => {
      try {
        await api.revokeInvite(r.id);
        ui.toast('Invite revoked', 'success');
        ctx.cache.delete('invites');
        ctx.redraw();
      } catch (e) { ui.toast(e.message, 'error'); }
    };
    row.appendChild(rev);
    hostEl.appendChild(row);
  }
}

// ------------------------------------------------------------------ audit
const VERB = {
  create_role: 'created a role', update_role: 'updated a role', delete_role: 'deleted a role',
  kick_member: 'removed a member', ban_member: 'banned a member', unban_member: 'lifted a ban',
  timeout_member: 'timed out a member', archive_channel: 'archived a channel',
  unarchive_channel: 'unarchived a channel', delete_channel: 'deleted a channel',
  update_channel: 'updated a channel', create_channel: 'created a channel',
  update_category: 'updated a category', delete_category: 'deleted a category',
  revoke_invite: 'revoked an invite', create_webhook: 'created a webhook',
  revoke_webhook: 'revoked a webhook', set_workspace_gate: 'changed who can join',
  leave_workspace: 'left the Space', approve_join_request: 'approved a join request',
  reject_join_request: 'rejected a join request', resolve_report: 'resolved a report',
};

function auditDetail(target) {
  if (!target || typeof target !== 'object') return '';
  const bits = [];
  if (target.user_id) bits.push(memberName(target.user_id));
  if (target.name) bits.push(target.name);
  if (target.reason) bits.push('reason: ' + target.reason);
  if (target.until) bits.push('until ' + new Date(target.until).toLocaleString());
  if (target.permissions != null) bits.push('permissions ' + target.permissions);
  if (!bits.length) {
    const j = JSON.stringify(target);
    if (j && j !== '{}' && j !== 'null') bits.push(plain(j, 90));
  }
  return bits.join(' · ');
}

async function drawAudit(host, ctx) {
  const rows = await cached(ctx, 'audit', () => api.adminAudit(store.ws.id, 100));
  host.innerHTML = '';
  if (!rows?.length) {
    host.appendChild(el('div', 'empty', 'Nothing logged yet. Role changes, bans, channel edits and invite revocations land here, newest first.'));
    return;
  }
  for (const a of rows) {
    const verb = VERB[a.action] || String(a.action || '').replace(/_/g, ' ');
    const detail = auditDetail(a.target);
    const row = el('div', 'admin-line');
    row.innerHTML = `<span><b>${esc(memberName(a.actor_id))}</b> ${esc(verb)}
      ${detail ? `<span class="muted">${esc(detail)}</span>` : ''}</span>
      <span class="admin-when">${esc(a.created_at ? relTime(a.created_at) : '')}</span>`;
    host.appendChild(row);
  }
}

// ------------------------------------------------------------------ register
const TABS = [
  ['overview', 'Overview', drawOverview],
  ['members', 'Members', drawMembers],
  ['channels', 'Channels', drawChannels],
  ['invites', 'Invites', drawInvites],
  ['audit', 'Audit', drawAudit],
];

export function register(app) {
  const { ui } = app;
  injectCss();

  ui.registerPanel({
    id: 'admin',
    title: 'Admin console',
    async render(body) {
      body.innerHTML = '';
      const root = el('div', 'admin-root');
      body.appendChild(root);

      if (!store.ws) {
        root.appendChild(el('div', 'empty', 'Open a Space first. The admin console reports on one Space at a time.'));
        return;
      }
      if (!canAdmin()) {
        root.appendChild(el('div', 'empty',
          'You need the "Manage workspace" permission to open the admin console. Ask an admin of this Space to grant it to one of your roles.'));
        return;
      }

      const tabsEl = el('div', 'admin-tabs');
      const tabBody = el('div', 'admin-tabbody');
      root.append(tabsEl, tabBody);

      // One cache per open panel. ctx.redraw() repaints the active tab from
      // whatever survived the invalidation an action just did.
      const ctx = { cache: new Map(), redraw: null };
      let active = 'overview';

      const draw = async () => {
        tabBody.innerHTML = '<div class="muted pad">loading…</div>';
        const tab = TABS.find((t) => t[0] === active);
        try {
          await tab[2](tabBody, ctx, app);
        } catch (e) {
          tabBody.innerHTML = `<div class="empty">${esc(e.message || 'that tab could not load')}</div>`;
        }
      };
      ctx.redraw = draw;

      const paintTabs = () => {
        tabsEl.innerHTML = '';
        for (const [id, label] of TABS) {
          const b = el('button', 'sm' + (id === active ? '' : ' ghost'), esc(label));
          b.onclick = () => { if (id === active) return; active = id; paintTabs(); draw(); };
          tabsEl.appendChild(b);
        }
      };

      paintTabs();
      await draw();
    },
  });

  ui.addHeaderButton({
    id: 'admin',
    label: icon('settings'),
    title: 'Admin console',
    order: 200,
    show: canAdmin,
    onClick: () => ui.openPanel('admin'),
  });

  ui.addSlashCommand({
    name: 'admin',
    description: 'Open the admin console',
    run: () => {
      if (!canAdmin()) return ui.toast('You need the "Manage workspace" permission for that', 'error');
      ui.openPanel('admin');
    },
  });
}
