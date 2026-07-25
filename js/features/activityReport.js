// The activity report an admin actually asks for.
//
// Nobody running a 30-person NGO wants an engagement score. They ask three
// questions, and they ask them out loud, in these words:
//   "who did we invite in March who never actually got in"
//   "who has gone quiet"
//   "which of these forty channels can I archive"
//
// admin_stats already returns three integers. This is the report those integers
// were a stand-in for. Every signal is one that already exists (read_state,
// workspace_members.joined_at, messages.created_at, channels.last_message_at), so
// there is no new write path and no new bookkeeping to get wrong.
import { rpc, tryRpc } from '../api.js';
import { store, bus, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, relTime } from '../util.js';
import { icon } from '../icons.js';

const CLS = 'rep';
const PANEL = 'activity-report';
let uiRef = null;
let quietDays = Number(localStorage.getItem('hearth.report.quiet')) || 30;

function humanError(e) {
  const m = String(e?.message || '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. Try again when you are back online.';
  if (/forbidden/i.test(m)) return 'You need the "Manage workspace" permission to see this. Ask an admin of this Space.';
  return 'That did not work. Try again in a moment.';
}

const dayWord = (n) => (n === 1 ? '1 day' : `${n} days`);

// ------------------------------------------------------------------ render
async function renderPanel(body, ctx = {}) {
  if (ctx.quietDays) quietDays = ctx.quietDays;
  body.innerHTML = '<div class="muted pad">loading…</div>';

  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }
  if (!hasPerm(PERM.MANAGE_WORKSPACE)) {
    body.innerHTML = `<div class="empty">You need the "Manage workspace" permission to see
      this report. Ask an admin of this Space to grant it.</div>`;
    return;
  }

  const [rep, err] = await tryRpc('admin_activity_report', {
    p_workspace: store.ws.id, p_quiet_days: quietDays, p_dead_days: quietDays });
  if (err) { body.innerHTML = `<div class="empty">${esc(humanError(err))}</div>`; return; }

  body.innerHTML = '';

  // ---- headline row -------------------------------------------------
  const t = rep.totals || {};
  const tiles = el('div', CLS + '-tiles');
  const tile = (n, label, warn = false) => {
    tiles.appendChild(el('div', CLS + '-tile' + (warn && n > 0 ? ' ' + CLS + '-warn' : ''),
      `<span class="${CLS}-n">${esc(String(n ?? 0))}</span><span class="${CLS}-l">${esc(label)}</span>`));
  };
  tile(t.members, 'people');
  tile(t.messages_7d, 'messages this week');
  tile(t.open_tasks, 'open tasks');
  tile(t.overdue_tasks, 'overdue', true);
  tile(t.open_forms, 'open forms');
  body.appendChild(tiles);

  // ---- the window control ------------------------------------------
  const ctrl = el('div', 'row gap ' + CLS + '-ctrl');
  ctrl.appendChild(el('span', 'muted', 'Count someone as quiet after'));
  for (const d of [14, 30, 60, 90]) {
    const b = el('button', 'sm ghost' + (d === quietDays ? ' on' : ''), dayWord(d));
    b.onclick = () => {
      quietDays = d;
      localStorage.setItem('hearth.report.quiet', String(d));
      uiRef.openPanel(PANEL, { quietDays: d });
    };
    ctrl.appendChild(b);
  }
  body.appendChild(ctrl);

  // ---- (a) never activated -----------------------------------------
  section(body, 'Never got started',
    'They joined and have never read or written anything. Usually the invite link '
    + 'worked and the app did not - worth a phone call, not another invite.',
    rep.never_activated, (r) => `
      <div><b>${esc(r.display_name || r.username || 'someone')}</b>
        ${r.username ? `<span class="muted">@${esc(r.username)}</span>` : ''}</div>
      <div class="muted ${CLS}-sub">joined ${esc(relTime(r.joined_at))} ·
        ${esc(dayWord(r.days_since_join || 0))} ago and nothing since</div>`,
    'Everyone who joined has used the app at least once.');

  // ---- (b) went quiet ----------------------------------------------
  section(body, `Gone quiet (over ${dayWord(quietDays)})`,
    'They were active once and have not read or posted since.',
    rep.went_quiet, (r) => `
      <div><b>${esc(r.display_name || r.username || 'someone')}</b>
        ${r.username ? `<span class="muted">@${esc(r.username)}</span>` : ''}</div>
      <div class="muted ${CLS}-sub">last seen ${esc(relTime(r.last_active))} ·
        quiet for ${esc(dayWord(r.days_quiet || 0))}</div>`,
    'Nobody has dropped off. That is unusual and good.');

  // ---- (c) dead channels -------------------------------------------
  section(body, `Quiet channels (over ${dayWord(quietDays)})`,
    'Nothing has been posted in these. Archiving them makes the sidebar readable again.',
    rep.dead_channels, (r) => `
      <div><b>#${esc(r.name || 'channel')}</b>
        ${r.is_private ? `<span class="${CLS}-pill">private</span>` : ''}</div>
      <div class="muted ${CLS}-sub">
        ${r.last_message_at
          ? `last message ${esc(relTime(r.last_message_at))} · silent ${esc(dayWord(r.days_silent || 0))}`
          : 'never used'} ·
        ${Number(r.message_count) || 0} messages · ${Number(r.member_count) || 0} can see it</div>`,
    'Every channel has been used recently.',
    (r) => archiveButton(r));

  const foot = el('div', 'muted ' + CLS + '-gen');
  foot.textContent = 'Generated ' + new Date(rep.generated_at).toLocaleString([], {
    dateStyle: 'medium', timeStyle: 'short' });
  body.appendChild(foot);
}

// Measured: at 887 members the whole report is 2.3 KB and 508 ms, so the server
// side needs no paging. The CLIENT does: a Space where 300 people joined and
// never opened the app would paint 300 rows on a low-end Android and jank the
// panel open. Render the first PAGE and let the admin ask for the rest.
const PAGE = 50;

function section(host, title, explain, rows, rowHtml, emptyText, extra) {
  const list = Array.isArray(rows) ? rows : [];
  host.appendChild(el('h4', 'sec', `${esc(title)} (${list.length})`));
  host.appendChild(el('p', 'muted ' + CLS + '-explain', esc(explain)));
  // Not the shell's `.empty`, which centres and pads for a whole panel. Three of
  // those stacked in one report is a screen and a half of dead space between the
  // three lists the admin came to compare.
  if (!list.length) { host.appendChild(el('div', CLS + '-none', esc(emptyText))); return; }

  const draw = (from, to) => {
    for (const r of list.slice(from, to)) {
      const card = el('div', 'result ' + CLS + '-row', rowHtml(r));
      const e = extra?.(r);
      if (e) card.appendChild(e);
      host.insertBefore(card, more);
    }
  };
  const more = el('button', 'sm ghost ' + CLS + '-more', `Show the other ${list.length - PAGE}`);
  host.appendChild(more);
  more.onclick = () => { draw(PAGE, list.length); more.remove(); };
  draw(0, PAGE);
  if (list.length <= PAGE) more.remove();
}

// Archiving is the one action this report should offer, because it is the one the
// admin came here to take. archive_channel already exists and is MANAGE_CHANNELS
// gated server side, so only offer the button to someone who holds it.
function archiveButton(r) {
  if (!hasPerm(PERM.MANAGE_CHANNELS)) return null;
  const b = el('button', 'sm ghost', 'Archive');
  b.onclick = async (ev) => {
    ev.stopPropagation();
    const ok = await uiRef.confirmModal({
      title: `Archive #${r.name}?`,
      body: 'It disappears from the sidebar. The messages are kept and an admin can bring it back.',
      confirmLabel: 'Archive', danger: true,
    });
    if (!ok) return;
    b.disabled = true;
    try {
      await rpc('archive_channel', { p_channel: r.channel_id, p_bool: true });
      uiRef.toast(`#${r.name} archived`, 'success');
      uiRef.openPanel(PANEL, { quietDays });
      bus.emit('channels');
    } catch (e) { b.disabled = false; uiRef.toast(humanError(e), 'error'); }
  };
  return b;
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));
  gap:var(--s-3);margin-bottom:var(--s-5)}
.${CLS}-tile{padding:var(--s-4);border:1px solid var(--c-border-subtle);border-radius:var(--r-md);
  background:var(--c-surface-2);display:flex;flex-direction:column;gap:var(--s-1)}
.${CLS}-tile.${CLS}-warn{border-color:var(--c-danger);background:var(--c-danger-quiet)}
.${CLS}-n{font-size:var(--t-xl);font-weight:var(--t-bold);font-variant-numeric:tabular-nums;
  color:var(--c-text)}
.${CLS}-warn .${CLS}-n{color:var(--c-danger)}
/* --c-text-3 measures 2.75:1 on surface-2 in the light theme. At 10.5px these
   labels are the smallest text in the panel; --c-text-2 is 5.38-6.72. */
.${CLS}-l{font-size:var(--t-2xs);color:var(--c-text-2);line-height:var(--t-tight)}
.${CLS}-ctrl{flex-wrap:wrap;align-items:center;margin-bottom:var(--s-5);font-size:var(--t-xs)}
.${CLS}-ctrl button{min-height:34px}
.${CLS}-explain{font-size:var(--t-xs);margin:calc(-1 * var(--s-2)) 0 var(--s-3);line-height:var(--t-snug)}
.${CLS}-row{display:flex;flex-direction:column;gap:var(--s-1)}
.${CLS}-row button{align-self:flex-start;margin-top:var(--s-2);min-height:36px}
.${CLS}-sub{font-size:var(--t-xs)}
.${CLS}-pill{margin-left:var(--s-2);font-size:var(--t-2xs);padding:var(--s-0) var(--s-3);
  border-radius:var(--r-xs);background:var(--c-surface-3);color:var(--c-text-2)}
.${CLS}-none{padding:var(--s-3) 0 var(--s-5);color:var(--c-text-2);font-size:var(--t-sm)}
.${CLS}-more{width:100%;min-height:40px;margin-bottom:var(--s-4)}
.${CLS}-gen{margin-top:var(--s-6);font-size:var(--t-2xs);text-align:center}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();

  ui.registerPanel({ id: PANEL, title: 'Who is active', render: renderPanel });

  ui.addHeaderButton({
    id: 'activity-report', label: icon('chart'), title: 'Who is active', order: 88,
    show: () => hasPerm(PERM.MANAGE_WORKSPACE),
    onClick: () => ui.openPanel(PANEL, { quietDays }),
  });

  ui.addSlashCommand({
    name: 'whoisactive',
    description: 'Who never got started, who went quiet, which channels are dead',
    run: () => ui.openPanel(PANEL, { quietDays }),
  });

  ui.addSwitcherSource({
    id: 'activity-report',
    search: (q) => (hasPerm(PERM.MANAGE_WORKSPACE) && /activ|quiet|dead|report|inactiv/i.test(q)
      ? [{ label: 'Who is active', hint: 'Never started, gone quiet, dead channels',
           icon: icon('chart'), run: () => ui.openPanel(PANEL, { quietDays }) }]
      : []),
  });
}
