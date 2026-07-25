// Make the coordination features reachable.
//
// WHY THIS FILE EXISTS. ackloop, forms, tasks, orientation and activityReport all
// registered themselves the documented way - ui.addHeaderButton - and every one of
// them was unreachable by clicking. Two things stack up:
//
//   1. ui.renderHeaderButtons() paints only the first `inlineCap` (4) buttons.
//      Measured on a signed-in page there are 16 registered and 4 in the DOM:
//      Threads, Activity, Saved, About-this-channel. Tasks, Forms, Confirmations
//      and Who-is-active all sort past the cap.
//   2. The overflow that is supposed to hold the other twelve - `#btnMore` in the
//      channel bar - has no click handler, because shell.js's initShell() is
//      imported by main.js and never called. Clicking it produces no DOM
//      mutation at all (measured).
//
// (2) is a shell bug outside this feature's ownership and is reported as such.
// This module is the fix that belongs here anyway, and is what the UX research
// asked for in the first place: labelled rows in the left rail rather than
// nameless icons in the far top-right corner, ~1000px from the channel list.
// Slack's exact model - one column, one place to look, a word next to the icon
// so a non-technical volunteer does not have to decode a hieroglyph.
//
// Everything here is a link to a panel another module registered. No state, no
// writes, no server calls of its own except the one that counts open tasks.
import { store, bus, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc } from '../util.js';
import { icon } from '../icons.js';

const CLS = 'cnav';

// renderNavSections() hands us a fresh host each time the sidebar is rebuilt;
// keep the live one so a count change repaints in place instead of waiting for
// the next channel switch.
let navHost = null;
let openTasks = 0;

const ROWS = [
  { id: 'tasks', panel: 'tasks', ico: 'check', label: 'Tasks',
    ctx: () => ({ tab: 'mine' }), badge: () => openTasks },
  { id: 'forms', panel: 'forms', ico: 'doc', label: 'Forms' },
  { id: 'ack-report', panel: 'ack-report', ico: 'megaphone', label: 'Confirmations',
    show: () => hasPerm(PERM.MANAGE_WORKSPACE) },
  { id: 'activity-report', panel: 'activity-report', ico: 'chart', label: 'Who is active',
    show: () => hasPerm(PERM.MANAGE_WORKSPACE) },
];

function paint(host, ui) {
  navHost = host;
  // No Space open means no panel behind any of these rows.
  if (!store.ws) { host.innerHTML = ''; return; }

  const rows = ROWS.filter((r) => !r.show || r.show());
  if (!rows.length) { host.innerHTML = ''; return; }

  // Same markup as the channel list and the topics section, so these inherit the
  // sidebar's hover, unread and touch-target rules rather than inventing their own.
  let h = `<h3><span>Coordination</span></h3><div class="navgroup ${CLS}-group">`;
  for (const r of rows) {
    const n = r.badge?.() || 0;
    h += `<div class="chan ${CLS}-row" data-cnav="${esc(r.id)}" title="${esc(r.label)}">
      <span class="ch-ico">${icon(r.ico)}</span>
      <span class="ch-name">${esc(r.label)}</span>
      ${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}</div>`;
  }
  h += '</div>';
  host.innerHTML = h;

  host.querySelectorAll('[data-cnav]').forEach((n) => {
    const def = ROWS.find((r) => r.id === n.dataset.cnav);
    n.onclick = () => ui.openPanel(def.panel, def.ctx ? def.ctx() : {});
  });
}

function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  // The channel list uses a text glyph in .ch-ico; these are SVGs, so give them a
  // size and let them take the row's colour like every other icon in the shell.
  s.textContent = `
.${CLS}-row .ch-ico{display:inline-flex;align-items:center;justify-content:center}
.${CLS}-row .ch-ico svg{width:15px;height:15px}
.${CLS}-row .badge{margin-left:auto}`;
  document.head.appendChild(s);
}

export function register({ ui }) {
  style();

  ui.addNavSection({
    id: 'coordination',
    order: 30,                     // under the channel list, below Topics (20)
    render: (host) => paint(host, ui),
  });

  // tasks.js owns the count; it publishes on the bus rather than being imported,
  // because a feature may never import another feature.
  bus.on('tasks:count', ({ open }) => {
    if (open === openTasks) return;
    openTasks = open;
    if (navHost?.isConnected) paint(navHost, ui);
  });

  // Permissions and the Space itself land after the first paint.
  bus.on('workspace', () => { if (navHost?.isConnected) paint(navHost, ui); });
}
