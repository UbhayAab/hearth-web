// Role management and @handle user groups.
//
// The interesting part is the permission bitfield. It is a Postgres bigint whose
// top bit (ADMINISTRATOR) is 1<<40, so it is built with BigInt arithmetic here
// and only converted at the wire edge - never accumulated in a JS number, where
// a future bit above 1<<52 would silently round. Every write reads the returned
// row back and compares the mask, so a mangled value shows up as a loud toast
// instead of a role that quietly grants the wrong thing.
//
// The server enforces anti-escalation (you cannot grant, or strip, a bit you do
// not hold, and you cannot touch a role at or above your own rank). This module
// does not try to predict those rules - it surfaces the server's own message.
import { api, table } from '../api.js';
import { store, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc } from '../util.js';
import { icon } from '../icons.js';

const canRoles = () => hasPerm(PERM.MANAGE_ROLES) || store.isAdmin;
// hasPerm() answers true for any platform admin, which is right for showing UI
// but wrong for deciding whether the Administrator bit is mine to hand out.
const holdsAdmin = () => {
  if (store.isAdmin) return true;
  try { return (BigInt(store.perms) & PERM.ADMINISTRATOR) !== 0n; } catch { return false; }
};

// Plain English, in the order they read best in a grid.
const PERM_LABELS = [
  ['SEND', 'Send messages'],
  ['MANAGE_MESSAGES', 'Manage messages'],
  ['MANAGE_CHANNELS', 'Manage channels'],
  ['MANAGE_ROLES', 'Manage roles'],
  ['KICK', 'Kick members'],
  ['BAN', 'Ban members'],
  ['MANAGE_WORKSPACE', 'Manage workspace'],
  ['CREATE_INVITE', 'Create invites'],
  ['MENTION_EVERYONE', 'Mention everyone'],
  ['MODERATE', 'Moderate'],
  ['MANAGE_THREADS', 'Manage threads'],
  ['ADMINISTRATOR', 'Administrator'],
];

const CSS = `
.roles-root{display:flex;flex-direction:column}
.roles-head{display:flex;align-items:center;gap:8px;margin:14px 4px 6px}
.roles-head h4{margin:0;flex:1;font-size:11px;text-transform:uppercase;color:var(--faint);letter-spacing:.6px}
.roles-row{display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--line)}
.roles-row:hover{background:var(--panel2)}
.roles-swatch{width:10px;height:10px;border-radius:50%;flex:none}
.roles-name{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roles-meta{color:var(--dim);font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roles-acts{display:flex;gap:4px;flex:none}
.roles-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin:4px 0 2px}
.roles-perm{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--line);
  border-radius:8px;padding:7px 9px;font-size:13px;cursor:pointer}
.roles-perm input{width:auto;flex:none}
.roles-perm-off{opacity:.45;cursor:not-allowed}
.roles-pick{max-height:300px;overflow:auto;margin-top:6px}
.roles-chiprow{display:flex;gap:4px;flex-wrap:wrap}
`;

function injectCss() {
  if (document.getElementById('roles-feature-css')) return;
  const s = document.createElement('style');
  s.id = 'roles-feature-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const hexOf = (color) => '#' + Number(color || 0).toString(16).padStart(6, '0');
const intOfHex = (hex) => {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, n)) : 0;
};

// Postgres bigint over PostgREST: a number is fine up to 2^53, and every mask we
// can build today (max 1099511629823) is far below that. Anything larger goes as
// a string so the JSON parser never sees a float.
const wirePerms = (mask) =>
  mask <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(mask) : mask.toString();

function permSummary(mask) {
  if ((mask & PERM.ADMINISTRATOR) !== 0n) return 'Administrator - every permission';
  const on = PERM_LABELS.filter(([k]) => (mask & PERM[k]) !== 0n).map(([, l]) => l);
  if (!on.length) return 'no permissions';
  return on.length > 3 ? on.slice(0, 3).join(', ') + ` +${on.length - 3} more` : on.join(', ');
}

// ------------------------------------------------------------------ editor
function permGridEl(mask) {
  const grid = el('div', 'roles-grid');
  const lockAdmin = !holdsAdmin();
  for (const [key, label] of PERM_LABELS) {
    const bit = PERM[key];
    const isAdminBit = key === 'ADMINISTRATOR';
    const locked = isAdminBit && lockAdmin;
    const row = el('label', 'roles-perm' + (locked ? ' roles-perm-off' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.bit = bit.toString();
    cb.checked = (mask & bit) !== 0n;
    if (locked) {
      cb.disabled = true;
      row.title = 'Only an administrator can grant or remove the Administrator permission';
    }
    row.append(cb, el('span', null, esc(label)));
    grid.appendChild(row);
  }
  return grid;
}

// Disabled boxes are still read, so a bit the current user cannot touch is
// carried through untouched instead of being silently stripped.
function maskFrom(gridEl) {
  let mask = 0n;
  for (const cb of gridEl.querySelectorAll('input[type=checkbox]')) {
    if (cb.checked) mask |= BigInt(cb.dataset.bit);
  }
  return mask;
}

function roleEditor(app, role, onSaved) {
  const { ui } = app;
  const mask0 = BigInt(role?.permissions ?? 0);
  const box = el('div', 'form');

  const nameField = el('label', 'field');
  nameField.appendChild(el('span', 'field-label', 'Role name'));
  const nameIn = el('input');
  nameIn.value = role?.name || '';
  nameIn.placeholder = 'Moderators';
  if (role?.is_everyone) {
    nameIn.disabled = true;
    nameField.appendChild(nameIn);
    nameField.appendChild(el('span', 'field-hint', '@everyone is structural - its name and rank cannot change, but its permissions can.'));
  } else {
    nameField.appendChild(nameIn);
  }

  const colorField = el('label', 'field');
  colorField.appendChild(el('span', 'field-label', 'Colour'));
  const colorIn = el('input');
  colorIn.type = 'color';
  colorIn.value = hexOf(role?.color);
  colorField.appendChild(colorIn);

  const grid = permGridEl(mask0);
  box.append(nameField, colorField, el('span', 'field-label', 'Permissions'), grid);
  if (!holdsAdmin()) {
    box.appendChild(el('p', 'muted', 'You can only grant permissions you hold yourself. Administrator is locked.'));
  }

  const m = ui.modal({
    title: role ? 'Edit role' : 'New role',
    body: box,
    wide: true,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (c) => c() },
      { label: role ? 'Save role' : 'Create role', onClick: async (close) => {
        const name = nameIn.value.trim();
        if (!role?.is_everyone && !name) return ui.toast('Give the role a name', 'error');
        const mask = maskFrom(grid);
        const color = intOfHex(colorIn.value);
        try {
          const saved = role
            ? await api.updateRole(role.id, {
              name: role.is_everyone ? null : name,
              permissions: wirePerms(mask),
              color,
            })
            : await api.createRole(store.ws.id, name, wirePerms(mask), color);
          // Round trip: what came back must be the exact mask we sent.
          const back = BigInt(saved?.permissions ?? 0);
          if (back !== mask) {
            ui.toast(`Saved, but the server stored ${back} instead of ${mask}`, 'error');
          } else {
            ui.toast(role ? 'Role updated' : 'Role created', 'success');
          }
          close();
          onSaved();
        } catch (e) {
          // Anti-escalation lives on the server. Say exactly what it said.
          ui.toast(e.message || 'the server refused that change', 'error');
        }
      } },
    ],
  });
  return m;
}

// ------------------------------------------------------------------ pickers
function pickPeople(app, title, preselected, onSave) {
  const { ui } = app;
  const chosen = new Set(preselected || []);
  const box = el('div');
  const search = el('input');
  search.placeholder = 'Search members';
  const list = el('div', 'roles-pick');
  box.append(search, list);

  const people = [...store.profiles.values()];
  const draw = (q = '') => {
    const needle = q.trim().toLowerCase();
    const rows = people.filter((p) => !needle ||
      (p.display_name || '').toLowerCase().includes(needle) ||
      (p.username || '').toLowerCase().includes(needle));
    list.innerHTML = '';
    if (!rows.length) { list.appendChild(el('div', 'empty', 'Nobody matches that search.')); return; }
    for (const p of rows) {
      const row = el('label', 'roles-perm');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = chosen.has(p.id);
      cb.onchange = () => (cb.checked ? chosen.add(p.id) : chosen.delete(p.id));
      row.append(cb, el('span', null, esc(p.display_name || p.username || 'user')));
      list.appendChild(row);
    }
  };
  search.oninput = () => draw(search.value);
  draw();

  ui.modal({
    title, body: box, wide: true,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (c) => c() },
      { label: 'Save members', onClick: async (close) => { close(); await onSave([...chosen]); } },
    ],
  });
}

// ------------------------------------------------------------------ panel
async function renderPanel(body, app) {
  const { ui } = app;
  body.innerHTML = '';
  const root = el('div', 'roles-root');
  body.appendChild(root);

  if (!store.ws) {
    root.appendChild(el('div', 'empty', 'Open a Space first. Roles belong to one Space.'));
    return;
  }

  root.innerHTML = '<div class="muted pad">loading…</div>';
  let roles;
  let memberRoles;
  let groups;
  let groupMembers;
  try {
    roles = await api.listRoles(store.ws.id);
    // No list_user_groups RPC exists, so the tables are read directly under RLS.
    [memberRoles, groups, groupMembers] = await Promise.all([
      table('member_roles', (q) => q.eq('workspace_id', store.ws.id)),
      table('user_groups', (q) => q.eq('workspace_id', store.ws.id)),
      table('user_group_members', (q) => q.eq('workspace_id', store.ws.id)),
    ]);
  } catch (e) {
    root.innerHTML = `<div class="empty">${esc(e.message || 'roles could not be loaded')}</div>`;
    return;
  }

  const redraw = () => renderPanel(body, app);
  const byId = new Map((roles || []).map((r) => [r.id, r]));
  const rolesOf = (userId) => (memberRoles || [])
    .filter((mr) => mr.user_id === userId)
    .map((mr) => byId.get(mr.role_id))
    .filter(Boolean);

  root.innerHTML = '';

  // ---- roles ----
  const rHead = el('div', 'roles-head');
  rHead.appendChild(el('h4', null, 'Roles'));
  if (canRoles()) {
    const add = el('button', 'sm', 'New role');
    add.onclick = () => roleEditor(app, null, redraw);
    rHead.appendChild(add);
  }
  root.appendChild(rHead);

  if (!roles?.length) {
    root.appendChild(el('div', 'empty', 'No roles yet. A role is a named bundle of permissions you hand to members - create one to start delegating.'));
  } else {
    const ordered = [...roles].sort((a, z) => (z.position || 0) - (a.position || 0));
    for (const r of ordered) {
      const mask = BigInt(r.permissions ?? 0);
      const row = el('div', 'roles-row');
      row.innerHTML = `
        <span class="roles-swatch" style="background:${r.color ? esc(hexOf(r.color)) : 'var(--faint)'}"></span>
        <span class="roles-name">${esc(r.name)}</span>
        <span class="roles-meta">${esc(Number(r.member_count || 0))} member${Number(r.member_count) === 1 ? '' : 's'} · ${esc(permSummary(mask))}</span>`;
      const acts = el('div', 'roles-acts');
      if (canRoles() && !r.managed) {
        const ed = el('button', 'sm ghost', 'Edit');
        ed.onclick = () => roleEditor(app, r, redraw);
        acts.appendChild(ed);
        if (!r.is_everyone) {
          const del = el('button', 'sm danger', 'Delete');
          del.onclick = async () => {
            if (!(await ui.confirmModal({
              title: 'Delete ' + r.name,
              body: 'Everyone holding this role loses the permissions it granted.',
              confirmLabel: 'Delete', danger: true,
            }))) return;
            try { await api.deleteRole(r.id); ui.toast('Role deleted', 'success'); redraw(); }
            catch (e) { ui.toast(e.message, 'error'); }
          };
          acts.appendChild(del);
        }
      } else if (r.managed) {
        acts.appendChild(el('span', 'muted', 'managed'));
      }
      row.appendChild(acts);
      root.appendChild(row);
    }
  }

  // ---- members ----
  root.appendChild(el('div', 'roles-head', '<h4>Members</h4>'));
  const people = [...store.profiles.values()];
  if (!people.length) {
    root.appendChild(el('div', 'empty', 'No members loaded yet. Open a channel first so the member list is fetched.'));
  } else {
    const search = el('input');
    search.placeholder = `Search ${people.length} members`;
    const list = el('div');
    root.append(search, list);
    const drawMembers = (q = '') => {
      const needle = q.trim().toLowerCase();
      const rows = people.filter((p) => !needle ||
        (p.display_name || '').toLowerCase().includes(needle) ||
        (p.username || '').toLowerCase().includes(needle));
      list.innerHTML = '';
      if (!rows.length) { list.appendChild(el('div', 'empty', 'No member matches that search.')); return; }
      for (const p of rows) {
        const has = rolesOf(p.id);
        const row = el('div', 'roles-row');
        row.innerHTML = `<span class="roles-name">${esc(p.display_name || p.username || 'user')}</span>
          <span class="roles-meta roles-chiprow">${has.length
            ? has.map((r) => `<span class="rolechip">${esc(r.name)}</span>`).join('')
            : '<span class="muted">no roles</span>'}</span>`;
        if (canRoles()) {
          const give = el('button', 'sm ghost', 'Give role');
          give.onclick = (ev) => assignMenu(app, p, roles, has, ev, redraw);
          row.appendChild(give);
        }
        list.appendChild(row);
      }
    };
    search.oninput = () => drawMembers(search.value);
    drawMembers();
  }

  // ---- user groups ----
  const gHead = el('div', 'roles-head');
  gHead.appendChild(el('h4', null, 'User groups'));
  if (canRoles()) {
    const add = el('button', 'sm', 'New group');
    add.onclick = () => createGroup(app, redraw);
    gHead.appendChild(add);
  }
  root.appendChild(gHead);

  if (!groups?.length) {
    root.appendChild(el('div', 'empty', 'No groups yet. A group is an @handle that pings a fixed set of people - handy for @design or @on-call.'));
  } else {
    for (const g of groups) {
      const members = (groupMembers || []).filter((m) => m.group_id === g.id);
      const row = el('div', 'roles-row');
      row.innerHTML = `<span class="roles-name">@${esc(g.handle)}</span>
        <span class="roles-meta">${esc(g.name)} · ${members.length} member${members.length === 1 ? '' : 's'}</span>`;
      if (canRoles()) {
        const edit = el('button', 'sm ghost', 'Members');
        edit.onclick = () => pickPeople(app, 'Members of @' + g.handle, members.map((m) => m.user_id), async (ids) => {
          try { await api.setUserGroupMembers(g.id, ids); ui.toast('Group updated', 'success'); redraw(); }
          catch (e) { ui.toast(e.message, 'error'); }
        });
        row.appendChild(edit);
      }
      root.appendChild(row);
    }
  }
}

function assignMenu(app, person, roles, has, ev, redraw) {
  const { ui } = app;
  const hasIds = new Set(has.map((r) => r.id));
  // @everyone is implicit and managed roles are owned by the server.
  const options = (roles || []).filter((r) => !r.is_everyone && !r.managed && !hasIds.has(r.id));
  if (!options.length) {
    ui.toast('No other role to give - create one first', 'info');
    return;
  }
  ui.contextMenu(ev, options.map((r) => ({
    label: r.name,
    onClick: async () => {
      try {
        await api.assignRole(store.ws.id, person.id, r.id);
        ui.toast(`${person.display_name || 'They'} now hold ${r.name}`, 'success');
        redraw();
      } catch (e) {
        // forbidden_hierarchy / forbidden_escalation come straight from the server.
        ui.toast(e.message || 'the server refused that assignment', 'error');
      }
    },
  })));
}

async function createGroup(app, redraw) {
  const { ui } = app;
  const out = await ui.formModal({
    title: 'New user group',
    note: 'Anyone can then type @handle to ping every member of the group at once.',
    fields: [
      { name: 'handle', label: 'Handle', required: true, placeholder: 'design', hint: 'Without the @. Letters, numbers and dashes.' },
      { name: 'name', label: 'Display name', required: true, placeholder: 'Design team' },
    ],
    submitLabel: 'Create group',
  });
  if (!out) return;
  const handle = out.handle.trim().replace(/^@/, '');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(handle)) {
    ui.toast('A handle is letters, numbers, dots or dashes - no spaces', 'error');
    return;
  }
  try {
    await api.createUserGroup(store.ws.id, handle, out.name.trim());
    ui.toast('Group created', 'success');
    redraw();
  } catch (e) { ui.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ register
export function register(app) {
  const { ui } = app;
  injectCss();

  ui.registerPanel({
    id: 'roles',
    title: 'Roles & groups',
    render: (body) => renderPanel(body, app),
  });

  ui.addHeaderButton({
    id: 'roles',
    label: icon('members'),
    title: 'Roles and user groups',
    order: 210,
    show: canRoles,
    onClick: () => ui.openPanel('roles'),
  });

  ui.addSlashCommand({
    name: 'roles',
    description: 'Manage roles and user groups',
    run: () => {
      if (!canRoles()) return ui.toast('You need the "Manage roles" permission for that', 'error');
      ui.openPanel('roles');
    },
  });
}
