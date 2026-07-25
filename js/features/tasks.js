// Tasks out of a message.
//
// "Can someone collect the receipts?" gets three thumbs-up and is done by nobody.
// This turns any message into an assignment with one person's name and a due date,
// and - the part that matters - drops it into the assignee's EXISTING Later queue
// rather than inventing a second inbox nobody opens.
//
// Two states, open and done. No projects, no boards, no dependencies, no subtasks.
// At 30 people the whole coordination problem is "who said they would do it and
// have they".
import { rpc, tryRpc, table } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, plain, relTime, toLocalInput, fromLocalInput } from '../util.js';
import { icon } from '../icons.js';
import { getSub } from '../sb.js';

const CLS = 'tsk';
const PANEL = 'tasks';

// message_id -> the open tasks hanging off it, so a message row can show a chip
// without a round trip per row.
const byMessage = new Map();
let openCount = 0;
let uiRef = null;
const toastFn = (...a) => uiRef?.toast(...a);

function humanError(e) {
  const m = String(e?.message || '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. Try again when you are back online.';
  if (/assignee_cannot_see_channel/i.test(m)) return 'That person cannot see this channel, so they would never find the task.';
  if (/forbidden/i.test(m)) return 'Only the person who made this task, the person it is for, or a moderator can change it.';
  if (/not_found/i.test(m)) return 'That task is gone.';
  if (/rate_limited/i.test(m)) return 'Slow down a moment, then try again.';
  if (/title_too_long/i.test(m)) return 'That title is too long.';
  return 'That did not work. Try again in a moment.';
}
const toastErr = (e) => toastFn(humanError(e), 'error');

// ------------------------------------------------------------------ helpers
const isOverdue = (t) => !t.done_at && t.due_at && new Date(t.due_at).getTime() <= Date.now();

function dueLabel(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const d = Math.round(abs / 86400000);
  const h = Math.round(abs / 3600000);
  const m = Math.round(abs / 60000);
  const unit = abs < 3600000 ? `${m}m` : abs < 172800000 ? `${h}h` : `${d}d`;
  return ms <= 0 ? `${unit} overdue` : `due in ${unit}`;
}

// Who can be given this task.
//
// This CANNOT come from store.profiles. That map is "every profile this client
// has ever seen" across every Space it has ever opened - measured at 1183 entries
// on a freshly signed-in account whose only Space had two members - so the picker
// filled up with strangers, and create_task then refused them with
// `assignee_cannot_see_channel`. A picker whose entries mostly error is worse than
// no picker.
//
// So read workspace_members for the Space we are actually in (wm_select RLS lets a
// member see their own Space's roster and nothing else) and look the names up in
// the profiles map, which by then holds them. One small request per dialog open,
// which is the right trade against handing someone a list they cannot use.
const MAX_ASSIGNEES = 200;

async function assigneeOptions(keep = null) {
  const people = [];
  if (store.ws) {
    const mem = await table('workspace_members', (q) => q.eq('workspace_id', store.ws.id));
    const ids = mem.map((m) => m.user_id);
    // Anyone core has not cached yet - a volunteer who joined while this tab was
    // open - would otherwise render as "someone".
    const unknown = ids.filter((u) => !store.profiles.has(u));
    if (unknown.length) {
      for (const p of await table('profiles', (q) => q.in('id', unknown.slice(0, 500)))) {
        store.profiles.set(p.id, { ...(store.profiles.get(p.id) || {}), ...p });
      }
    }
    for (const id of ids) {
      const p = store.profiles.get(id) || {};
      if (p.is_ghost) continue;                       // deleted accounts cannot do a task
      people.push({ value: id, label: p.display_name || p.username || 'someone' });
    }
  }
  people.sort((a, z) => a.label.localeCompare(z.label));

  const list = people.slice(0, MAX_ASSIGNEES);
  // Me and the current holder must always be selectable even past the cap.
  for (const id of [keep, store.me]) {
    if (id && !list.some((o) => o.value === id)) {
      const found = people.find((o) => o.value === id);
      if (found) list.unshift(found);
    }
  }
  return [{ value: '', label: 'Nobody yet' }, ...list];
}

// ------------------------------------------------------------------ create
async function createDialog(msg) {
  const preset = plain(msg.body_text || '', 120);
  const out = await uiRef.formModal({
    title: 'Make this a task',
    fields: [
      { name: 'title', label: 'What needs doing', value: preset, required: true,
        placeholder: 'Collect the receipts' },
      { name: 'assignee', label: 'Who is doing it', type: 'select', options: await assigneeOptions(),
        value: store.me, hint: 'They will see it in their Later queue straight away.' },
      { name: 'due', label: 'Due by (optional)', type: 'datetime-local',
        hint: 'They get one reminder when it falls due. Leave blank for no deadline.' },
    ],
    submitLabel: 'Create task',
  });
  if (!out) return;

  try {
    await rpc('create_task', {
      p_message: msg.id,
      p_title: out.title.trim() || null,
      p_assignee: out.assignee || null,
      p_due_at: out.due ? fromLocalInput(out.due) : null,
    });
    toastFn('Task created', 'success');
    await refreshChips();
    refreshCount();
  } catch (e) { toastErr(e); }
}

// ------------------------------------------------------------------ message chip
// One chip under the message, so the commitment lives where the ask was made.
function paintChip(host, tasks) {
  if (!tasks.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = '';
  host.innerHTML = '';

  for (const t of tasks) {
    const chip = el('div', CLS + '-chip' + (t.done_at ? ' ' + CLS + '-chipdone' : '')
      + (isOverdue(t) ? ' ' + CLS + '-chiplate' : ''));
    const who = t.assignee_id ? nameOf(t.assignee_id) : 'nobody yet';
    chip.innerHTML = `${icon('check')}<span class="${CLS}-chiptext">${esc(t.title)}</span>
      <span class="${CLS}-chipwho">${esc(who)}</span>
      ${t.due_at ? `<span class="${CLS}-chipdue">${esc(dueLabel(t.due_at))}</span>` : ''}`;

    const mayFlip = t.assignee_id === store.me || t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES);
    if (mayFlip) {
      const b = el('button', 'sm ghost', t.done_at ? 'Reopen' : 'Mark done');
      b.type = 'button';
      b.onclick = async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        try {
          await rpc('set_task_done', { p_task: t.id, p_done: !t.done_at });
          await refreshChips();
          refreshCount();
        } catch (e) { b.disabled = false; toastErr(e); }
      };
      chip.appendChild(b);
    }
    host.appendChild(chip);
  }
}

// A message you just sent is painted optimistically with the client nonce as its
// id, and core's upgradeMessageRow() then rewrites row.dataset.id to the real one
// WITHOUT re-emitting message:render. Anything a feature stamped at render time is
// therefore stale for exactly the message the user is looking at.
//
// Measured: the row ended up data-id=019f9a15-16a7-... (server uuidv7) while the
// slot inside it still said data-msg=1995bd17-2511-... (the v4 nonce), so the chip
// for a task you had just created never appeared until a reload.
//
// The row is the authority. Read the id off it at paint time and re-stamp.
function slotMessageId(slot) {
  const live = slot.closest('.msg')?.dataset.id;
  if (live && live !== slot.dataset.msg) slot.dataset.msg = live;
  return slot.dataset.msg;
}

// One workspace-scoped read repaints every chip on screen. Per-message lookups
// would be one request per rendered row, which on 3G is the wrong trade.
async function refreshChips() {
  if (!store.ws) return;
  const [rows] = await tryRpc('list_tasks', {
    p_workspace: store.ws.id, p_filter: 'all', p_channel: null, p_include_done: true });
  if (!Array.isArray(rows)) return;
  byMessage.clear();
  for (const t of rows) {
    if (!byMessage.has(t.message_id)) byMessage.set(t.message_id, []);
    byMessage.get(t.message_id).push(t);
  }
  for (const h of document.querySelectorAll('.' + CLS + '-slot')) {
    paintChip(h, byMessage.get(slotMessageId(h)) || []);
  }
}

function mount(msg, row) {
  if (!msg?.id || msg.conversation_id) return;
  const existing = row.querySelector('.' + CLS + '-slot');
  if (existing) {
    // Re-render of a row we already decorated: keep the node, refresh the id.
    if (existing.dataset.msg !== msg.id) {
      existing.dataset.msg = msg.id;
      paintChip(existing, byMessage.get(msg.id) || []);
    }
    return;
  }
  const body = row.querySelector('.body') || row;
  const slot = el('div', CLS + '-slot');
  slot.dataset.msg = msg.id;
  slot.style.display = 'none';
  body.appendChild(slot);
  const known = byMessage.get(msg.id);
  if (known) paintChip(slot, known);
}

// ------------------------------------------------------------------ panel
const TABS = [
  { key: 'mine', label: 'For me', empty: 'Nothing is assigned to you. That is a good thing.' },
  { key: 'assigned', label: 'I asked for', empty: 'You have not asked anyone to do anything yet.' },
  { key: 'all', label: 'Everything', empty: 'No tasks in this Space yet.' },
];
// Validated, not trusted: a stale value from an older build would make
// TABS.find() return undefined and throw while rendering the empty state.
let activeTab = TABS.some((t) => t.key === localStorage.getItem('hearth.tasks.tab'))
  ? localStorage.getItem('hearth.tasks.tab') : 'mine';

async function renderPanel(body, ctx = {}) {
  if (ctx.tab) activeTab = ctx.tab;
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }

  const bar = el('div', 'row gap ' + CLS + '-tabs');
  for (const t of TABS) {
    const b = el('button', 'sm ghost' + (t.key === activeTab ? ' on' : ''), esc(t.label));
    b.onclick = () => {
      activeTab = t.key;
      localStorage.setItem('hearth.tasks.tab', t.key);
      uiRef.openPanel(PANEL, { tab: t.key });
    };
    bar.appendChild(b);
  }

  const [rows, err] = await tryRpc('list_tasks', {
    p_workspace: store.ws.id, p_filter: activeTab, p_channel: null, p_include_done: true });

  body.innerHTML = '';
  body.appendChild(bar);

  if (err) { body.appendChild(el('div', 'empty', esc(humanError(err)))); return; }

  const tabDef = TABS.find((t) => t.key === activeTab) || TABS[0];
  const list = rows || [];
  const open = list.filter((t) => !t.done_at);
  const done = list.filter((t) => t.done_at).slice(0, 25);
  openCount = activeTab === 'mine' ? open.length : openCount;

  if (!list.length) {
    const e = el('div', 'empty', esc(tabDef.empty) + '<br><br>');
    e.appendChild(document.createTextNode('To make one: press and hold a message '
      + '(or hover it on a computer), open the ... menu and pick "Make this a task".'));
    body.appendChild(e);
    return;
  }

  const overdue = open.filter(isOverdue);
  const rest = open.filter((t) => !isOverdue(t));

  const section = (title, items) => {
    if (!items.length) return;
    body.appendChild(el('h4', 'sec', esc(title) + ` (${items.length})`));
    for (const t of items) body.appendChild(taskCard(t));
  };
  section('Overdue', overdue);
  section('Open', rest);
  section('Done', done);
}

function taskCard(t) {
  const card = el('div', 'result ' + CLS + '-card' + (t.done_at ? ' ' + CLS + '-carddone' : ''));
  const who = t.assignee_id ? nameOf(t.assignee_id) : 'nobody yet';
  card.innerHTML = `
    <div class="${CLS}-cardtop">
      <span class="${CLS}-cardtitle">${esc(t.title)}</span>
      ${t.due_at ? `<span class="${CLS}-due${isOverdue(t) ? ' ' + CLS + '-late' : ''}">${esc(dueLabel(t.due_at))}</span>` : ''}
    </div>
    <div class="${CLS}-meta muted">
      <b>${esc(who)}</b> · #${esc(t.channel_name || 'channel')} ·
      asked by ${esc(nameOf(t.created_by))} · ${esc(relTime(t.created_at))}
    </div>
    ${t.body_text ? `<div class="${CLS}-quote">${esc(plain(t.body_text, 160))}</div>` : ''}`;

  const bar = el('div', 'row gap ' + CLS + '-bar');
  const mayFlip = t.assignee_id === store.me || t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES);

  if (mayFlip) {
    const b = el('button', 'sm' + (t.done_at ? ' ghost' : ''), t.done_at ? 'Reopen' : 'Mark done');
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try {
        await rpc('set_task_done', { p_task: t.id, p_done: !t.done_at });
        uiRef.openPanel(PANEL, { tab: activeTab });
        refreshCount();
      } catch (err) { b.disabled = false; toastErr(err); }
    };
    bar.appendChild(b);

    const ed = el('button', 'sm ghost', 'Edit');
    ed.onclick = (e) => { e.stopPropagation(); editDialog(t); };
    bar.appendChild(ed);
  }

  const jump = el('button', 'sm ghost', 'Go to message');
  jump.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: t.message_id }); };
  bar.appendChild(jump);

  if (t.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES)) {
    const rm = el('button', 'sm ghost', 'Delete');
    rm.onclick = async (e) => {
      e.stopPropagation();
      const ok = await uiRef.confirmModal({
        title: 'Delete this task?',
        body: 'The message stays. Only the task disappears.',
        confirmLabel: 'Delete', danger: true,
      });
      if (!ok) return;
      try {
        await rpc('delete_task', { p_task: t.id });
        uiRef.openPanel(PANEL, { tab: activeTab });
        refreshCount();
      } catch (err) { toastErr(err); }
    };
    bar.appendChild(rm);
  }

  card.appendChild(bar);
  card.onclick = () => bus.emit('message:jump', { messageId: t.message_id });
  return card;
}

async function editDialog(t) {
  const out = await uiRef.formModal({
    title: 'Edit task',
    fields: [
      { name: 'title', label: 'What needs doing', value: t.title, required: true },
      { name: 'assignee', label: 'Who is doing it', type: 'select',
        options: await assigneeOptions(t.assignee_id), value: t.assignee_id || '' },
      { name: 'due', label: 'Due by', type: 'datetime-local',
        value: t.due_at ? toLocalInput(t.due_at) : '',
        hint: 'Clear this box to remove the deadline.' },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;
  try {
    await rpc('update_task', {
      p_task: t.id,
      p_title: out.title.trim() || null,
      p_assignee: out.assignee || null,
      p_due_at: out.due ? fromLocalInput(out.due) : null,
      p_clear_due: !out.due,
    });
    uiRef.openPanel(PANEL, { tab: activeTab });
    refreshCount();
  } catch (e) { toastErr(e); }
}

// ------------------------------------------------------------------ badge
function paintBadge() {
  const btn = document.getElementById('hb-' + PANEL);
  if (!btn) return;
  const want = openCount > 0
    ? icon('check') + `<span class="badge ${CLS}-badge">${openCount > 99 ? '99+' : openCount}</span>`
    : icon('check');
  if (btn.innerHTML !== want) btn.innerHTML = want;
}

async function refreshCount() {
  if (!store.me || !store.ws) return;
  const [rows] = await tryRpc('list_tasks', {
    p_workspace: store.ws.id, p_filter: 'mine', p_channel: null, p_include_done: false });
  if (!Array.isArray(rows)) return;
  openCount = rows.length;
  paintBadge();
  // The header button only exists when Tasks lands inside ui.inlineCap, which on
  // a full registry it does not. Publish the number so the sidebar row - the
  // surface people actually reach this through - can carry the badge instead.
  bus.emit('tasks:count', { open: openCount });
}

// Core rebuilds the header row whenever any feature adds a button, which wipes the
// badge. Watching the row is cheaper than fighting the render order.
function watchHeader() {
  const host = document.getElementById('headerActions');
  if (!host) return;
  new MutationObserver(paintBadge).observe(host, { childList: true });
}

// ------------------------------------------------------------------ realtime
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'task_update' }, () => {
    refreshChips();
    refreshCount();
  });
  return true;
}
function scheduleBind() {
  clearInterval(rebind);
  let tries = 0;
  rebind = setInterval(() => { if (bindChannel() || ++tries > 20) clearInterval(rebind); }, 400);
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-slot{display:flex;flex-direction:column;gap:var(--s-2);margin-top:var(--s-3)}
.${CLS}-chip{display:flex;align-items:center;gap:var(--s-3);flex-wrap:wrap;max-width:520px;
  padding:var(--s-3) var(--s-4);border:1px solid var(--c-border);border-left:3px solid var(--c-accent);
  border-radius:var(--r-md);background:var(--c-surface-2);font-size:var(--t-sm)}
.${CLS}-chip svg{width:15px;height:15px;flex:none;color:var(--c-accent)}
.${CLS}-chipdone{border-left-color:var(--c-success);opacity:.75}
.${CLS}-chipdone svg{color:var(--c-success)}
.${CLS}-chipdone .${CLS}-chiptext{text-decoration:line-through}
.${CLS}-chiplate{border-left-color:var(--c-danger)}
.${CLS}-chiptext{font-weight:var(--t-semibold);word-break:break-word}
.${CLS}-chipwho{color:var(--c-text-2)}
/* --c-warn as text is 2.83:1 on surface-2 in the colorful theme. The chip is
   already colour-coded by its left border, so the label reads in --c-text-2. */
.${CLS}-chipdue{color:var(--c-text-2)}
.${CLS}-chiplate .${CLS}-chipdue{color:var(--c-danger)}
.${CLS}-chip button{margin-left:auto;min-height:32px}

.${CLS}-tabs{margin-bottom:var(--s-4);flex-wrap:wrap}
.${CLS}-tabs button{min-height:36px}
.${CLS}-card{cursor:pointer}
.${CLS}-carddone .${CLS}-cardtitle{text-decoration:line-through;opacity:.7}
.${CLS}-cardtop{display:flex;gap:var(--s-4);align-items:baseline;flex-wrap:wrap}
.${CLS}-cardtitle{flex:1;font-weight:var(--t-semibold);word-break:break-word}
.${CLS}-due{font-size:var(--t-xs);color:var(--c-text-2);white-space:nowrap}
.${CLS}-late{color:var(--c-danger);font-weight:var(--t-semibold)}
.${CLS}-meta{font-size:var(--t-xs);margin-top:var(--s-2);word-break:break-word}
.${CLS}-quote{margin-top:var(--s-3);padding-left:var(--s-4);
  border-left:2px solid var(--c-border);color:var(--c-text-2);font-size:var(--t-sm)}
.${CLS}-bar{margin-top:var(--s-3);flex-wrap:wrap;gap:var(--s-2)}
.${CLS}-bar button{min-height:36px}
.${CLS}-badge{margin-left:var(--s-1);vertical-align:top}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();
  watchHeader();

  bus.on('message:render', ({ msg, el: row }) => mount(msg, row));
  bus.on('channel:open', () => { scheduleBind(); refreshChips(); });
  bus.on('workspace', () => { refreshCount(); });
  bus.on('auth', refreshCount);
  scheduleBind();
  refreshCount();

  ui.addMessageAction({
    id: 'make-task',
    label: icon('check'),
    title: 'Make this a task',
    order: 44,
    contexts: ['channel', 'thread'],
    show: (m) => !!m.id && !m.conversation_id,
    onClick: (m, ev) => { ev?.stopPropagation?.(); createDialog(m); },
  });

  ui.registerPanel({ id: PANEL, title: 'Tasks', render: renderPanel });

  ui.addHeaderButton({
    id: PANEL, label: icon('check'), title: 'Tasks', order: 74,
    onClick: () => ui.openPanel(PANEL, { tab: activeTab }),
  });

  ui.addSlashCommand({
    name: 'tasks',
    description: 'Show what you are on the hook for',
    run: () => ui.openPanel(PANEL, { tab: 'mine' }),
  });

  ui.addSwitcherSource({
    id: 'tasks',
    search: (q) => (/task|todo|due/i.test(q)
      ? [{ label: 'My tasks', hint: 'What you are on the hook for', icon: icon('check'),
           run: () => ui.openPanel(PANEL, { tab: 'mine' }) }]
      : []),
  });
}
