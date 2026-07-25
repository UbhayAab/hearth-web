// Moderation: the open-report queue, automod rules, per-channel slowmode and
// read-only, and your own block list.
//
// Slowmode and read-only are enforced here in the client. send_message does not
// check either column server-side today (it only enforces timeout_until and the
// generic rate limit), so the honest job of this module is to stop people typing
// into a message that the room does not want, not to pretend it is a security
// boundary.
import { nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, fmt, plain, relTime } from '../util.js';
import { icon } from '../icons.js';

const STYLE_ID = 'mod-style';
const STYLE = `
.mod-sec{margin-bottom:16px}
.mod-sec .sec{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.6px;color:var(--faint)}
.mod-sec .sec .sp{flex:1}
.mod-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.mod-line{display:flex;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px solid var(--line)}
.mod-line .sp{flex:1}
.mod-pat{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;
  background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.mod-kind{font-size:10px;font-weight:800;letter-spacing:.4px;padding:1px 6px;border-radius:5px;
  background:var(--panel3);color:var(--dim)}
.mod-kind.block{background:#31191a;color:#ff9a8f}
.mod-kind.flag{background:#3a2f12;color:#e0a44a}
.mod-quote{border-left:2px solid var(--line);padding:2px 9px;margin:5px 0 0;color:var(--dim);font-size:13px}
.mod-ctl{display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap}
.mod-ctl select{width:auto;min-width:150px}
.mod-note{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim);
  background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px 10px;margin-bottom:6px}
.mod-note.mod-lock{border-color:#5a2a24;background:#31191a;color:#ff9a8f}
`;

// 0 is "off"; the server rejects anything above 6 hours.
const SLOWMODE_PRESETS = [
  { value: 0, label: 'Off' }, { value: 5, label: '5 seconds' }, { value: 10, label: '10 seconds' },
  { value: 30, label: '30 seconds' }, { value: 60, label: '1 minute' }, { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' }, { value: 3600, label: '1 hour' }, { value: 21600, label: '6 hours' },
];

const TIMEOUTS = [
  { value: '600', label: '10 minutes' }, { value: '3600', label: '1 hour' },
  { value: '86400', label: '1 day' }, { value: '604800', label: '1 week' },
];

const humanSlow = (s) => (SLOWMODE_PRESETS.find((p) => p.value === s)?.label)
  || (s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`);

export function register(app) {
  const { ui, api, store, bus, sb } = app;

  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- helpers
  // api.table() swallows errors into []; the panel needs to tell "nothing here"
  // apart from "you are not allowed to look", so read through sb directly.
  const read = async (name, build) => {
    let q = sb.from(name).select('*');
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  };

  const canModerate = () => hasPerm(PERM.MODERATE) || hasPerm(PERM.MANAGE_MESSAGES)
    || hasPerm(PERM.MANAGE_WORKSPACE);
  const canManageChannels = () => hasPerm(PERM.MANAGE_CHANNELS);
  // get_bootstrap renames channels.readonly to is_readonly; the legacy table read
  // keeps the raw name. Accept both rather than guess which path loaded us.
  const readonlyOf = (ch) => !!(ch?.is_readonly ?? ch?.readonly);
  const slowmodeOf = (ch) => Number(ch?.slowmode_seconds || 0);
  // Nobody enforces this server-side, so mirror who can already reshape a
  // channel: if you can flip the switch you can post through it.
  const bypassesReadonly = () => canManageChannels() || hasPerm(PERM.MANAGE_MESSAGES);

  const patchChannel = (id, patch) => {
    const inList = store.channels.find((c) => c.id === id);
    if (inList) Object.assign(inList, patch);
    if (store.current?.id === id) Object.assign(store.current, patch);
  };

  // ---------------------------------------------------------------- panel
  ui.registerPanel({
    id: 'moderation',
    title: 'Moderation',
    async render(body) {
      body.innerHTML = '';
      if (!store.ws) {
        body.appendChild(ui.emptyState('Open a Space first. Moderation tools are per Space.'));
        return;
      }
      // Sections load in parallel and fail independently: a moderator with no
      // report access should still get their automod list and block list.
      await Promise.all([
        reportsSection(body),
        automodSection(body),
        channelSection(body),
        blockedSection(body),
      ]);
    },
  });

  // A section owns its own loading / empty / error states.
  async function sectionShell(host, title, headBtn) {
    const wrap = el('div', 'mod-sec');
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

  // ---------------------------------------------------------------- reports
  async function reportsSection(host) {
    if (!canModerate()) return;
    const inner = await sectionShell(host, 'Open reports');
    try {
      const reports = await read('reports', (q) => q
        .eq('workspace_id', store.ws.id).eq('status', 'open')
        .order('created_at', { ascending: false }).limit(50));
      inner.innerHTML = '';
      if (!reports.length) {
        inner.appendChild(ui.emptyState(
          'No open reports. When someone uses Report on a message it lands here.'));
        return;
      }
      const ids = [...new Set(reports.map((r) => r.message_id).filter(Boolean))];
      let byId = new Map();
      if (ids.length) {
        const msgs = await read('messages', (q) => q.in('id', ids));
        byId = new Map(msgs.map((m) => [m.id, m]));
      }
      for (const r of reports) inner.appendChild(reportCard(r, byId.get(r.message_id)));
    } catch (e) { fail(inner, e); }
  }

  function reportCard(r, msg) {
    const card = el('div', 'result');
    const author = msg ? nameOf(msg.author_id) : 'unknown author';
    card.innerHTML = `
      <div class="muted"><b>${esc(nameOf(r.reporter_id))}</b> reported
        <b>${esc(author)}</b> · ${esc(relTime(r.created_at))}</div>
      <div class="body">${esc(r.reason || 'No reason given')}</div>
      <div class="mod-quote">${msg
        ? fmt(plain(msg.body_text, 200))
        : '<span class="muted">the reported message is gone or you cannot see its channel</span>'}</div>`;

    const bar = el('div', 'mod-actions');
    const resolve = async (status, label) => {
      try {
        await api.resolveReport(r.id, status);
        ui.toast(label);
        card.remove();
      } catch (e) { ui.toast(e.message, 'error'); }
    };

    if (msg && (hasPerm(PERM.MANAGE_MESSAGES) || hasPerm(PERM.MODERATE))) {
      const del = el('button', 'sm danger', 'Delete message');
      del.onclick = async () => {
        if (!(await ui.confirmModal({
          title: 'Delete this message', body: 'This cannot be undone.',
          confirmLabel: 'Delete', danger: true,
        }))) return;
        try { await api.del(msg.id); ui.toast('Message deleted'); await resolve('reviewed', 'Report closed'); }
        catch (e) { ui.toast(e.message, 'error'); }
      };
      bar.appendChild(del);
    }
    if (msg && hasPerm(PERM.MODERATE)) {
      const to = el('button', 'sm ghost', 'Timeout author');
      to.onclick = () => timeoutDialog(msg.author_id);
      bar.appendChild(to);
    }
    if (msg && hasPerm(PERM.BAN)) {
      const ban = el('button', 'sm ghost', 'Ban author');
      ban.onclick = async () => {
        if (!(await ui.confirmModal({
          title: 'Ban ' + nameOf(msg.author_id),
          body: 'They lose access and cannot rejoin with any invite.',
          confirmLabel: 'Ban', danger: true,
        }))) return;
        try { await api.ban(store.ws.id, msg.author_id, plain(r.reason, 120) || null); ui.toast('Banned'); }
        catch (e) { ui.toast(e.message, 'error'); }
      };
      bar.appendChild(ban);
    }
    if (msg) {
      const jump = el('button', 'sm ghost', 'Go to message');
      jump.onclick = () => bus.emit('message:jump', { messageId: msg.id });
      bar.appendChild(jump);
    }
    const dismiss = el('button', 'sm ghost', 'Dismiss');
    dismiss.onclick = () => resolve('dismissed', 'Report dismissed');
    bar.appendChild(dismiss);

    card.appendChild(bar);
    return card;
  }

  async function timeoutDialog(userId) {
    const out = await ui.formModal({
      title: 'Timeout ' + nameOf(userId),
      note: 'They stay in the Space but cannot send anything until the timeout expires.',
      fields: [{ name: 'secs', label: 'For how long', type: 'select', options: TIMEOUTS }],
      submitLabel: 'Apply timeout',
    });
    if (!out) return;
    const until = new Date(Date.now() + Number(out.secs) * 1000).toISOString();
    try { await api.timeout(store.ws.id, userId, until); ui.toast('Timeout applied'); }
    catch (e) { ui.toast(e.message, 'error'); }
  }

  // ---------------------------------------------------------------- automod
  async function automodSection(host) {
    if (!canModerate()) return;
    let addBtn = null;
    if (hasPerm(PERM.MANAGE_WORKSPACE)) {
      addBtn = el('button', 'sm ghost', 'Add rule');
      addBtn.onclick = addAutomodDialog;
    }
    const inner = await sectionShell(host, 'Automod rules', addBtn);
    try {
      const rules = await read('automod_rules', (q) => q
        .eq('workspace_id', store.ws.id).order('created_at', { ascending: false }));
      inner.innerHTML = '';
      if (!rules.length) {
        inner.appendChild(ui.emptyState(
          'No automod rules yet. A rule is a pattern; matching messages are either blocked outright or flagged for review.'));
        return;
      }
      for (const r of rules) {
        const line = el('div', 'mod-line', `
          <span class="mod-pat">${esc(r.pattern)}</span>
          <span class="mod-kind ${r.kind === 'block' ? 'block' : 'flag'}">${esc(r.kind || '')}</span>
          <span class="sp"></span>
          <span class="muted">${esc(relTime(r.created_at))}</span>`);
        if (hasPerm(PERM.MANAGE_WORKSPACE)) {
          const rm = el('button', 'sm ghost', 'Remove');
          rm.onclick = async () => {
            try { await api.removeAutomod(r.id); line.remove(); ui.toast('Rule removed'); }
            catch (e) { ui.toast(e.message, 'error'); }
          };
          line.appendChild(rm);
        }
        inner.appendChild(line);
      }
    } catch (e) { fail(inner, e); }
  }

  async function addAutomodDialog() {
    const out = await ui.formModal({
      title: 'New automod rule',
      fields: [
        { name: 'pattern', label: 'Pattern', required: true, placeholder: 'crypto giveaway',
          hint: 'Matched against the message text.' },
        { name: 'kind', label: 'What should happen', type: 'select', options: [
          { value: 'flag', label: 'Flag it for the moderators' },
          { value: 'block', label: 'Block the message' }] },
      ],
      submitLabel: 'Add rule',
    });
    if (!out) return;
    try {
      await api.addAutomod(store.ws.id, out.pattern.trim(), out.kind);
      ui.toast('Rule added', 'success');
      ui.refreshPanel();
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  // ---------------------------------------------------------------- channel
  async function channelSection(host) {
    const inner = await sectionShell(host, 'This channel');
    const ch = store.current;
    inner.innerHTML = '';
    if (!ch) {
      inner.appendChild(ui.emptyState(
        'Open a text channel to set its slowmode or make it read-only.'));
      return;
    }
    const slow = slowmodeOf(ch);
    const ro = readonlyOf(ch);
    inner.appendChild(el('div', 'muted', `<b>#${esc(ch.name)}</b> ·
      ${slow ? `slowmode ${esc(humanSlow(slow))}` : 'no slowmode'} ·
      ${ro ? 'read-only' : 'open to everyone who can post'}`));

    if (!canManageChannels()) {
      inner.appendChild(el('div', 'muted', 'You need Manage Channels to change these.'));
      return;
    }

    const ctl = el('div', 'mod-ctl');
    const sel = el('select');
    for (const p of SLOWMODE_PRESETS) {
      const o = el('option', null, esc(p.label));
      o.value = String(p.value);
      sel.appendChild(o);
    }
    sel.value = String(SLOWMODE_PRESETS.some((p) => p.value === slow) ? slow : 0);
    sel.onchange = async () => {
      const secs = Number(sel.value);
      try {
        await api.setSlowmode(ch.id, secs);
        patchChannel(ch.id, { slowmode_seconds: secs });
        cooldownUntil = 0;
        paintComposer();
        ui.toast(secs ? 'Slowmode set to ' + humanSlow(secs) : 'Slowmode off', 'success');
        ui.refreshPanel();
      } catch (e) { ui.toast(e.message, 'error'); sel.value = String(slow); }
    };
    ctl.append(el('span', 'muted', 'Slowmode'), sel);

    const toggle = el('button', 'sm ghost' + (ro ? ' on' : ''), ro ? 'Read-only is on' : 'Make read-only');
    toggle.onclick = async () => {
      try {
        await api.setReadonly(ch.id, !ro);
        patchChannel(ch.id, { readonly: !ro, is_readonly: !ro });
        paintComposer();
        ui.toast(!ro ? '#' + ch.name + ' is now read-only' : 'Read-only lifted', 'success');
        ui.refreshPanel();
      } catch (e) { ui.toast(e.message, 'error'); }
    };
    ctl.appendChild(toggle);
    inner.appendChild(ctl);
  }

  // ---------------------------------------------------------------- blocked
  async function blockedSection(host) {
    const inner = await sectionShell(host, 'People you have blocked');
    try {
      const rows = await read('user_blocks', (q) => q.eq('blocker_id', store.me));
      inner.innerHTML = '';
      if (!rows.length) {
        inner.appendChild(ui.emptyState(
          'You have not blocked anyone. Block someone from their profile card and they show up here.'));
        return;
      }
      for (const b of rows) {
        const line = el('div', 'mod-line', `<span>${esc(nameOf(b.blocked_id))}</span>
          <span class="sp"></span><span class="muted">${esc(relTime(b.created_at))}</span>`);
        const un = el('button', 'sm ghost', 'Unblock');
        un.onclick = async () => {
          try { await api.unblockUser(b.blocked_id); line.remove(); ui.toast('Unblocked'); }
          catch (e) { ui.toast(e.message, 'error'); }
        };
        line.appendChild(un);
        inner.appendChild(line);
      }
    } catch (e) { fail(inner, e); }
  }

  // ---------------------------------------------------------------- header
  ui.addHeaderButton({
    id: 'moderation', label: icon('shield'), title: 'Moderation', order: 190,
    show: () => canModerate(),
    onClick: () => ui.openPanel('moderation'),
  });

  // ---------------------------------------------------------------- composer
  // The composer lives in index.html, which features must not touch, so the
  // slowmode/read-only strip is created here and parked above the input row.
  let noteEl = null;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let weDisabled = false;

  function ensureNote() {
    if (noteEl?.isConnected) return noteEl;
    const bar = $('composerBar');
    const crow = bar?.querySelector('.crow');
    if (!bar || !crow) return null;
    noteEl = el('div', 'mod-note hidden');
    noteEl.id = 'modComposerNote';
    bar.insertBefore(noteEl, crow);
    return noteEl;
  }

  const remaining = () => Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

  function paintComposer() {
    const note = ensureNote();
    const c = $('composer');
    const send = $('sendBtn');
    if (!note || !c || !send) return;

    const ch = store.currentDM ? null : store.current;
    if (!ch) {
      note.classList.add('hidden');
      if (weDisabled) { c.disabled = false; send.disabled = false; weDisabled = false; }
      return;
    }

    if (readonlyOf(ch) && !bypassesReadonly()) {
      note.className = 'mod-note mod-lock';
      note.innerHTML = `🔒 <span>#${esc(ch.name)} is read-only. Only people who manage this
        channel can post here - you can still read and react.</span>`;
      c.disabled = true;
      send.disabled = true;
      weDisabled = true;
      return;
    }
    if (weDisabled) { c.disabled = false; send.disabled = false; weDisabled = false; }

    const slow = slowmodeOf(ch);
    if (!slow) { note.classList.add('hidden'); send.disabled = false; return; }

    const left = remaining();
    note.className = 'mod-note';
    note.innerHTML = left
      ? `🐢 <span>Slowmode ${esc(humanSlow(slow))} · you can send again in <b>${left}s</b></span>`
      : `🐢 <span>Slowmode: one message every ${esc(humanSlow(slow))}</span>`;
    send.disabled = left > 0;
  }

  function startCooldown(seconds) {
    cooldownUntil = Date.now() + seconds * 1000;
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      if (remaining() <= 0) { clearInterval(cooldownTimer); cooldownTimer = null; cooldownUntil = 0; }
      paintComposer();
    }, 250);
    paintComposer();
  }

  function stopCooldown() {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
    cooldownUntil = 0;
  }

  // Core wires its send handlers straight onto #composer and #sendBtn, and at the
  // target phase listeners fire in registration order - core registers first. The
  // only way to get in front of it is to capture on an ancestor.
  function onSendAttempt(e) {
    const ch = store.currentDM ? null : store.current;
    if (!ch) return;
    const c = $('composer');
    const text = (c?.value || '').trim();

    if (readonlyOf(ch) && !bypassesReadonly()) {
      e.preventDefault();
      e.stopPropagation();
      ui.toast('#' + ch.name + ' is read-only', 'error');
      return;
    }
    const left = remaining();
    if (left > 0) {
      e.preventDefault();
      e.stopPropagation();
      ui.toast(`Slowmode: ${left}s to go`, 'error');
      return;
    }
    // Slash commands are not messages, so they do not spend the interval.
    if (!text || text.startsWith('/')) return;
    const slow = slowmodeOf(ch);
    if (slow > 0) startCooldown(slow);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.target?.id !== 'composer') return;
    onSendAttempt(e);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.target?.closest?.('#sendBtn')) return;
    onSendAttempt(e);
  }, true);

  bus.on('channel:open', () => { stopCooldown(); paintComposer(); });
  bus.on('dm:open', () => { stopCooldown(); paintComposer(); });
  bus.on('workspace', () => { stopCooldown(); paintComposer(); });
  bus.on('channels', () => paintComposer());

  // ---------------------------------------------------------------- commands
  ui.addSlashCommand({
    name: 'slowmode',
    description: 'Set slowmode on this channel, in seconds (0 turns it off)',
    run: async (arg) => {
      if (!store.current) return ui.toast('Open a channel first', 'error');
      const secs = Math.round(Number((arg || '').trim()));
      if (!Number.isFinite(secs) || secs < 0 || secs > 21600) {
        return ui.toast('Give a number of seconds between 0 and 21600', 'error');
      }
      await api.setSlowmode(store.current.id, secs);
      patchChannel(store.current.id, { slowmode_seconds: secs });
      stopCooldown();
      paintComposer();
      ui.toast(secs ? 'Slowmode set to ' + humanSlow(secs) : 'Slowmode off', 'success');
    },
  });

  ui.addSlashCommand({
    name: 'readonly',
    description: 'Make this channel read-only (/readonly off to lift it)',
    run: async (arg) => {
      if (!store.current) return ui.toast('Open a channel first', 'error');
      const on = !/^(off|false|0|no)$/i.test((arg || '').trim());
      await api.setReadonly(store.current.id, on);
      patchChannel(store.current.id, { readonly: on, is_readonly: on });
      paintComposer();
      ui.toast(on ? 'Channel is read-only' : 'Read-only lifted', 'success');
    },
  });

  paintComposer();
}
