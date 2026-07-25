// Join gates: the rules a Space makes you agree to, the queue of people waiting
// to be let in, the roles you can pick up yourself, and reaction roles.
//
// The rules gate is deliberately not a normal modal. ui.modal() closes on Escape
// and on a backdrop click, and a gate you can dismiss by pressing Escape is not a
// gate. This one only closes when you agree or when you leave.
import { nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { tryRpc } from '../api.js';
import { el, esc, fmt, relTime } from '../util.js';
import { icon } from '../icons.js';

const STYLE_ID = 'onb-style';
const STYLE = `
.onb-sec{margin-bottom:16px}
.onb-sec .sec{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.6px;color:var(--faint)}
.onb-sec .sec .sp{flex:1}
.onb-line{display:flex;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px solid var(--line)}
.onb-line .sp{flex:1}
.onb-rules{max-height:46vh;overflow:auto;background:var(--panel2);border:1px solid var(--line);
  border-radius:10px;padding:12px 14px}
.onb-rr{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;
  font-size:12px;color:var(--dim);background:var(--panel2);border:1px solid var(--line);
  border-radius:10px;padding:2px 9px}
.onb-rr b{color:var(--text)}
.onb-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
`;

const LEVELS = [
  { value: '0', label: '0 - Open. Anyone with a link walks in.' },
  { value: '1', label: '1 - Low. A verified email is expected.' },
  { value: '2', label: '2 - Strict. Verified and vetted before posting.' },
];

export function register(app) {
  const { ui, api, store, bus, sb } = app;

  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // Read through sb rather than api.table() so a permission failure reads as an
  // error in the panel instead of a silent empty list.
  const read = async (name, build) => {
    let q = sb.from(name).select('*');
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  };

  const canGate = () => hasPerm(PERM.MANAGE_WORKSPACE);
  const canDecide = () => hasPerm(PERM.MANAGE_WORKSPACE) || hasPerm(PERM.KICK);
  const canManageRoles = () => hasPerm(PERM.MANAGE_ROLES);

  // Caches filled on every workspace switch so message rendering stays synchronous.
  let rolesById = new Map();
  let rrByMessage = new Map();   // message_id -> [{emoji, role_id}]
  let hasSelfRoles = false;

  const roleName = (id) => rolesById.get(id)?.name || 'a role';

  // ---------------------------------------------------------------- caches
  async function loadCaches(ws) {
    rolesById = new Map();
    rrByMessage = new Map();
    hasSelfRoles = false;
    const [roles] = await tryRpc('list_roles', { p_workspace: ws.id });
    for (const r of roles || []) rolesById.set(r.id, r);
    try {
      const rr = await read('reaction_roles', (q) => q.eq('workspace_id', ws.id));
      for (const m of rr) {
        if (!rrByMessage.has(m.message_id)) rrByMessage.set(m.message_id, []);
        rrByMessage.get(m.message_id).push({ emoji: m.emoji, role_id: m.role_id });
      }
    } catch { /* reaction roles are a nicety; never block the Space on them */ }
    try {
      const self = await read('self_roles', (q) => q.eq('workspace_id', ws.id));
      hasSelfRoles = self.length > 0;
    } catch { hasSelfRoles = false; }
    // The header button is gated on being an admin OR having roles to pick up,
    // and we only learn the second half after this fetch.
    ui.renderHeaderButtons();
  }

  // ---------------------------------------------------------------- rules gate
  function showRulesGate(ws, rules) {
    if (document.getElementById('onbGate')) return;
    const back = el('div', 'modal-back');
    back.id = 'onbGate';
    const box = el('div', 'modal');
    box.innerHTML = `
      <div class="modal-head"><strong>Before you join ${esc(ws.name || 'this Space')}</strong></div>
      <div class="modal-body">
        <p class="muted">Everyone here agreed to this. Read it, then agree or leave.</p>
        <div class="onb-rules body">${fmt(rules)}</div>
      </div>`;
    const foot = el('div', 'modal-foot');
    const leave = el('button', 'ghost', 'Leave this Space');
    const agree = el('button', '', 'I agree');
    foot.append(leave, agree);
    box.appendChild(foot);
    back.appendChild(box);

    // Swallow Escape while the gate is up: core's shortcut handler is on window,
    // so capturing on document gets there first.
    const swallow = (e) => {
      if (e.key === 'Escape' && document.getElementById('onbGate')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const close = () => {
      document.removeEventListener('keydown', swallow, true);
      back.remove();
    };
    document.addEventListener('keydown', swallow, true);

    agree.onclick = async () => {
      agree.disabled = true;
      try {
        await api.acceptRules(ws.id);
        close();
        ui.toast('Welcome to ' + (ws.name || 'the Space'), 'success');
      } catch (e) { agree.disabled = false; ui.toast(e.message, 'error'); }
    };
    leave.onclick = async () => {
      if (!(await ui.confirmModal({
        title: 'Leave ' + (ws.name || 'this Space'),
        body: 'You will need a new invite link to come back.',
        confirmLabel: 'Leave', danger: true,
      }))) return;
      try {
        await api.leaveWorkspace(ws.id);
        close();
        location.reload();
      } catch (e) { ui.toast(e.message, 'error'); }
    };

    document.body.appendChild(back);
    agree.focus();
  }

  async function checkRulesGate(ws) {
    const rules = (ws?.rules_text || '').trim();
    if (!rules || !store.me) return;
    try {
      const rows = await read('member_rules_accepted', (q) => q
        .eq('workspace_id', ws.id).eq('user_id', store.me));
      if (rows.length) return;
      if (store.ws?.id !== ws.id) return;   // they switched Space while we asked
      showRulesGate(ws, rules);
    } catch { /* if we cannot tell, do not lock anyone out of their own Space */ }
  }

  bus.on('workspace', ({ ws }) => {
    if (!ws) return;
    loadCaches(ws).catch(() => {});
    checkRulesGate(ws);
  });

  // ---------------------------------------------------------------- panel
  ui.registerPanel({
    id: 'onboarding',
    title: 'Joining this Space',
    async render(body) {
      body.innerHTML = '';
      if (!store.ws) {
        body.appendChild(ui.emptyState('Open a Space first. Join gates are per Space.'));
        return;
      }
      await Promise.all([
        gateSection(body),
        requestsSection(body),
        selfRolesSection(body),
        reactionRolesSection(body),
      ]);
    },
  });

  async function sectionShell(host, title, headBtn) {
    const wrap = el('div', 'onb-sec');
    const head = el('h4', 'sec', `<span>${esc(title)}</span><span class="sp"></span>`);
    if (headBtn) head.appendChild(headBtn);
    const inner = el('div', null, '<div class="muted pad">loading…</div>');
    wrap.append(head, inner);
    host.appendChild(wrap);
    return inner;
  }

  const fail = (host, e) => {
    host.innerHTML = '';
    host.appendChild(ui.emptyState(e?.message || 'could not load'));
  };

  // ---------------------------------------------------------------- gate form
  async function gateSection(host) {
    if (!canGate()) return;
    const inner = await sectionShell(host, 'Join gate');
    const ws = store.ws;
    inner.innerHTML = `
      <label class="field"><span class="field-label">Verification level</span>
        <select id="onbLevel">${LEVELS.map((l) =>
          `<option value="${esc(l.value)}">${esc(l.label)}</option>`).join('')}</select></label>
      <label class="field field-check"><input type="checkbox" id="onbApprove" />
        <span class="field-label">New members must be approved by a moderator</span></label>
      <label class="field"><span class="field-label">Rules</span>
        <textarea id="onbRules" rows="6" placeholder="Be kind. No spam. Keep #general on topic."></textarea>
        <span class="field-hint">Leave empty for no rules gate. Anything here is shown once, full screen, to every member who has not agreed yet.</span></label>`;
    inner.querySelector('#onbLevel').value = String(ws.verification_level ?? 0);
    inner.querySelector('#onbApprove').checked = !!ws.requires_approval;
    inner.querySelector('#onbRules').value = ws.rules_text || '';

    const actions = el('div', 'onb-actions');
    const save = el('button', 'sm', 'Save gate');
    save.onclick = async () => {
      const level = Number(inner.querySelector('#onbLevel').value);
      const approval = inner.querySelector('#onbApprove').checked;
      const rules = inner.querySelector('#onbRules').value;
      save.disabled = true;
      try {
        const row = await api.setWorkspaceGate(ws.id, level, approval, rules);
        // Keep the in-memory Space row honest, otherwise the rules gate would
        // pop for the admin who just wrote the rules on the next switch.
        const patch = {
          verification_level: row?.verification_level ?? level,
          requires_approval: row?.requires_approval ?? approval,
          rules_text: row?.rules_text ?? rules,
        };
        Object.assign(store.ws, patch);
        const inList = store.spaces.find((s) => s.id === ws.id);
        if (inList) Object.assign(inList, patch);
        if ((patch.rules_text || '').trim()) await api.acceptRules(ws.id).catch(() => {});
        ui.toast('Join gate saved', 'success');
      } catch (e) { ui.toast(e.message, 'error'); }
      save.disabled = false;
    };
    actions.appendChild(save);
    inner.appendChild(actions);
  }

  // ---------------------------------------------------------------- requests
  async function requestsSection(host) {
    if (!canDecide()) return;
    const inner = await sectionShell(host, 'Waiting to join');
    try {
      const rows = await read('workspace_join_requests', (q) => q
        .eq('workspace_id', store.ws.id).eq('status', 'pending')
        .order('created_at', { ascending: true }));
      inner.innerHTML = '';
      if (!rows.length) {
        inner.appendChild(ui.emptyState(store.ws.requires_approval
          ? 'Nobody is waiting. People who open an invite link land here until you approve them.'
          : 'Nobody is waiting, and this Space does not ask for approval - turn on "must be approved" above to start a queue.'));
        return;
      }
      // Profiles of non-members are usually not readable, so fall back to the id.
      for (const r of rows) {
        const label = store.profiles.has(r.user_id) ? nameOf(r.user_id)
          : 'someone (' + String(r.user_id).slice(0, 8) + ')';
        const line = el('div', 'onb-line', `<span>${esc(label)}</span>
          <span class="sp"></span><span class="muted">${esc(relTime(r.created_at))}</span>`);
        const ok = el('button', 'sm', 'Approve');
        const no = el('button', 'sm ghost', 'Reject');
        ok.onclick = async () => {
          try { await api.approveJoin(r.id); line.remove(); ui.toast('Approved', 'success'); }
          catch (e) { ui.toast(e.message, 'error'); }
        };
        no.onclick = async () => {
          try { await api.rejectJoin(r.id); line.remove(); ui.toast('Rejected'); }
          catch (e) { ui.toast(e.message, 'error'); }
        };
        line.append(ok, no);
        inner.appendChild(line);
      }
    } catch (e) { fail(inner, e); }
  }

  // ---------------------------------------------------------------- self roles
  async function selfRolesSection(host) {
    let addBtn = null;
    if (canManageRoles()) {
      addBtn = el('button', 'sm ghost', 'Offer a role');
      addBtn.onclick = offerRoleDialog;
    }
    const inner = await sectionShell(host, 'Get roles', addBtn);
    try {
      const [self, mine] = await Promise.all([
        read('self_roles', (q) => q.eq('workspace_id', store.ws.id)),
        read('member_roles', (q) => q.eq('workspace_id', store.ws.id).eq('user_id', store.me)),
      ]);
      hasSelfRoles = self.length > 0;
      const held = new Set(mine.map((m) => m.role_id));
      inner.innerHTML = '';
      if (!self.length) {
        inner.appendChild(ui.emptyState(canManageRoles()
          ? 'No self-assignable roles yet. Offer one and members can pick it up without asking.'
          : 'No roles to pick up here yet. Admins can open roles for anyone to take.'));
        return;
      }
      for (const s of self) {
        const r = rolesById.get(s.role_id);
        const has = held.has(s.role_id);
        const line = el('div', 'onb-line',
          `<span class="rolechip">${esc(r?.name || 'role')}</span><span class="sp"></span>`);
        const btn = el('button', 'sm ' + (has ? 'ghost on' : 'ghost'), has ? 'Leave' : 'Join');
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            if (has) { await api.selfUnassignRole(store.ws.id, s.role_id); ui.toast('Role removed'); }
            else { await api.selfAssignRole(store.ws.id, s.role_id); ui.toast('Role added', 'success'); }
            ui.refreshPanel();
          } catch (e) { btn.disabled = false; ui.toast(e.message, 'error'); }
        };
        line.appendChild(btn);
        if (canManageRoles()) {
          const stop = el('button', 'sm ghost', 'Stop offering');
          stop.onclick = async () => {
            try { await api.removeSelfRole(store.ws.id, s.role_id); line.remove(); ui.toast('No longer offered'); }
            catch (e) { ui.toast(e.message, 'error'); }
          };
          line.appendChild(stop);
        }
        inner.appendChild(line);
      }
    } catch (e) { fail(inner, e); }
  }

  async function offerRoleDialog() {
    const options = [...rolesById.values()]
      .filter((r) => !r.is_everyone && !r.managed)
      .map((r) => ({ value: r.id, label: r.name }));
    if (!options.length) return ui.toast('Create a role first', 'error');
    const out = await ui.formModal({
      title: 'Offer a role to everyone',
      note: 'Anyone in this Space will be able to give themselves this role and take it off again.',
      fields: [{ name: 'role', label: 'Role', type: 'select', options }],
      submitLabel: 'Offer it',
    });
    if (!out) return;
    try {
      await api.addSelfRole(store.ws.id, out.role);
      ui.toast('Role is now self-assignable', 'success');
      ui.renderHeaderButtons();
      ui.refreshPanel();
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  // ---------------------------------------------------------------- reaction roles
  async function reactionRolesSection(host) {
    if (!canManageRoles()) return;
    const inner = await sectionShell(host, 'Reaction roles');
    try {
      const rows = await read('reaction_roles', (q) => q.eq('workspace_id', store.ws.id));
      inner.innerHTML = '';
      if (!rows.length) {
        inner.appendChild(ui.emptyState(
          'No reaction roles. Use "Set reaction role" on a message and anyone who reacts with that emoji gets the role.'));
        return;
      }
      for (const r of rows) {
        const line = el('div', 'onb-line', `<span>${esc(r.emoji)}</span>
          <span class="rolechip">${esc(roleName(r.role_id))}</span><span class="sp"></span>`);
        const jump = el('button', 'sm ghost', 'Go to message');
        jump.onclick = () => bus.emit('message:jump', { messageId: r.message_id });
        const rm = el('button', 'sm ghost', 'Remove');
        rm.onclick = async () => {
          try {
            await api.removeReactionRole(r.message_id, r.emoji);
            const list = (rrByMessage.get(r.message_id) || []).filter((x) => x.emoji !== r.emoji);
            if (list.length) rrByMessage.set(r.message_id, list); else rrByMessage.delete(r.message_id);
            line.remove();
            ui.toast('Mapping removed');
          } catch (e) { ui.toast(e.message, 'error'); }
        };
        line.append(jump, rm);
        inner.appendChild(line);
      }
    } catch (e) { fail(inner, e); }
  }

  ui.addMessageAction({
    id: 'reaction-role', label: '🎭', title: 'Set reaction role', order: 320,
    contexts: ['channel', 'thread'],
    show: () => canManageRoles(),
    onClick: (m) => reactionRoleDialog(m),
  });

  async function reactionRoleDialog(m) {
    const options = [{ value: '', label: 'Remove the mapping for this emoji' },
      ...[...rolesById.values()].filter((r) => !r.is_everyone && !r.managed)
        .map((r) => ({ value: r.id, label: r.name }))];
    const existing = rrByMessage.get(m.id) || [];
    const out = await ui.formModal({
      title: 'Reaction role',
      note: existing.length
        ? 'Already mapped: ' + existing.map((x) => `${x.emoji} -> ${roleName(x.role_id)}`).join(', ')
        : 'People who react to this message with the emoji get the role.',
      fields: [
        { name: 'emoji', label: 'Emoji', required: true, value: existing[0]?.emoji || '', placeholder: '🎨' },
        { name: 'role', label: 'Role', type: 'select', options },
      ],
      submitLabel: 'Save',
    });
    if (!out) return;
    const emoji = out.emoji.trim();
    try {
      if (!out.role) {
        await api.removeReactionRole(m.id, emoji);
        const list = existing.filter((x) => x.emoji !== emoji);
        if (list.length) rrByMessage.set(m.id, list); else rrByMessage.delete(m.id);
        ui.toast('Mapping removed');
      } else {
        await api.setReactionRole(m.id, emoji, out.role);
        const list = existing.filter((x) => x.emoji !== emoji);
        list.push({ emoji, role_id: out.role });
        rrByMessage.set(m.id, list);
        ui.toast('Reaction role set', 'success');
      }
      decorate(m.id);
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  // Repaint the hint on a message that is already on screen.
  function decorate(messageId) {
    const row = document.getElementById('m' + messageId);
    if (!row) return;
    row.querySelector('.onb-rr')?.remove();
    addHint(row, messageId);
  }

  function addHint(row, messageId) {
    const maps = rrByMessage.get(messageId);
    if (!maps?.length) return;
    const mbody = row.querySelector('.mbody');
    if (!mbody) return;
    const hint = el('div', 'onb-rr', 'React to get a role: ' + maps
      .map((x) => `${esc(x.emoji)} <b>${esc(roleName(x.role_id))}</b>`).join(' · '));
    mbody.insertBefore(hint, mbody.querySelector('.rxns'));
  }

  bus.on('message:render', ({ msg, el: row }) => {
    if (msg?.id && row) addHint(row, msg.id);
  });

  // Reaction buttons are painted after message:render, so claim the click by
  // delegation instead of binding to a button that does not exist yet. Core's
  // own toggle still runs - this only adds the role side effect.
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.rxn[data-e]');
    if (!btn) return;
    const id = btn.closest('.msg')?.dataset?.id;
    if (!id) return;
    const emoji = btn.dataset.e;
    const map = (rrByMessage.get(id) || []).find((x) => x.emoji === emoji);
    if (!map) return;
    const held = store.rxn.get(id)?.get(emoji)?.has(store.me);
    if (held) {
      // Taking the reaction back should take the role back, but only self-assignable
      // roles can be dropped that way - stay quiet when the server says no.
      tryRpc('self_unassign_role', { p_workspace: store.ws?.id, p_role: map.role_id });
      return;
    }
    api.applyReactionRole(id, emoji)
      .then((role) => { if (role) ui.toast('You now have ' + roleName(map.role_id), 'success'); })
      .catch((err) => ui.toast(err.message, 'error'));
  }, true);

  // ---------------------------------------------------------------- header
  ui.addHeaderButton({
    id: 'onboarding', label: icon('lock'), title: 'Joining this Space', order: 195,
    // Admins manage the gate; everyone else still needs a door to the roles on offer.
    show: () => canGate() || canDecide() || canManageRoles() || hasSelfRoles,
    onClick: () => ui.openPanel('onboarding'),
  });

  ui.addSlashCommand({
    name: 'roles',
    description: 'Pick up a self-assignable role',
    run: () => ui.openPanel('onboarding'),
  });

  ui.addSlashCommand({
    name: 'rules',
    description: 'Show the rules of this Space',
    run: () => {
      const rules = (store.ws?.rules_text || '').trim();
      if (!rules) return ui.toast('This Space has no rules set', 'info');
      ui.modal({
        title: 'Rules of ' + (store.ws.name || 'this Space'),
        body: `<div class="onb-rules body">${fmt(rules)}</div>`,
      });
    },
  });
}
