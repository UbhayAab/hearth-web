// Polls, rendered as live cards inside the message list.
//
// create_poll posts an ordinary message whose jsonb body is
// {type:'poll', poll_id, question}. We hook `message:render` and swap that row's
// body for a real card, so a poll reads as part of the conversation instead of
// a link out to somewhere else. get_poll is the only source of truth for counts;
// a click paints optimistically and is then reconciled against it.
import { api, table, tryRpc } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, relTime, fromLocalInput } from '../util.js';
import { getSub } from '../sb.js';
import { icon } from '../icons.js';

const MAX_FORM_OPTIONS = 6;

// pollId -> the last shape get_poll returned. Cards repaint from here, and the
// optimistic path mutates a clone of it so a failed vote can be rolled back.
const cache = new Map();

// ------------------------------------------------------------------ helpers
const isClosed = (p) =>
  !!p.closed || (!!p.closes_at && new Date(p.closes_at).getTime() <= Date.now());

const canClose = (p) => p.created_by === store.me || hasPerm(PERM.MANAGE_MESSAGES);

// relTime only speaks about the past; polls need the other direction.
function untilText(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return 'closed';
  if (s < 60) return 'closes in under a minute';
  if (s < 3600) return `closes in ${Math.round(s / 60)}m`;
  if (s < 86400) return `closes in ${Math.round(s / 3600)}h`;
  return 'closes ' + new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const totalVotes = (p) => (p.options || []).reduce((n, o) => n + (+o.count || 0), 0);

async function loadPoll(id, force = false) {
  if (!force && cache.has(id)) return cache.get(id);
  const data = await api.getPoll(id);
  cache.set(id, data);
  return data;
}

// ------------------------------------------------------------------ card
function paintCard(host, poll) {
  const closed = isClosed(poll);
  const total = totalVotes(poll);
  const mine = new Set(poll.my_votes || []);

  host.className = 'poll-card' + (closed ? ' poll-closed' : '');
  host.dataset.poll = poll.id;
  host.innerHTML = `
    <div class="poll-head">
      <div class="poll-q">${esc(poll.question)}</div>
      <span class="poll-tag">${closed ? 'CLOSED' : poll.multi ? 'PICK MANY' : 'POLL'}</span>
    </div>
    <div class="poll-opts"></div>
    <div class="poll-foot">
      <span class="muted poll-count"></span>
      <span class="sp"></span>
    </div>`;

  const opts = host.querySelector('.poll-opts');
  for (const o of poll.options || []) {
    const n = +o.count || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const voted = mine.has(o.id);
    const b = el('button', 'poll-opt' + (voted ? ' mine' : ''), `
      <span class="poll-fill" style="width:${pct}%"></span>
      <span class="poll-tick">${voted ? '✓' : ''}</span>
      <span class="poll-txt">${esc(o.text)}</span>
      <span class="poll-num">${n} · ${pct}%</span>`);
    b.type = 'button';
    if (closed) b.disabled = true;
    else b.onclick = (ev) => { ev.stopPropagation(); castVote(poll.id, o.id); };
    opts.appendChild(b);
  }

  const voters = poll.total_voters || 0;
  host.querySelector('.poll-count').textContent =
    `${voters} ${voters === 1 ? 'voter' : 'voters'}` +
    (closed ? ' · final' : poll.closes_at ? ' · ' + untilText(poll.closes_at) : '');

  const foot = host.querySelector('.poll-foot');
  if (!closed && canClose(poll)) {
    const c = el('button', 'sm ghost', 'Close poll');
    c.onclick = async (ev) => {
      ev.stopPropagation();
      c.disabled = true;
      try {
        await api.closePoll(poll.id);
        repaint(poll.id, true);
      } catch (e) {
        c.disabled = false;
        toastErr(e);
      }
    };
    foot.appendChild(c);
  }
}

let toastFn = null;
const toastErr = (e) => toastFn?.(e?.message || 'that did not work', 'error');

// Every mounted card for a poll lives in the DOM; repaint by query rather than
// bookkeeping a node registry that would leak as channels are switched.
async function repaint(pollId, force = false) {
  const nodes = document.querySelectorAll(`.poll-card[data-poll="${CSS.escape(pollId)}"]`);
  if (!nodes.length) { if (force) cache.delete(pollId); return; }
  try {
    const poll = await loadPoll(pollId, force);
    for (const n of nodes) paintCard(n, poll);
  } catch (e) {
    for (const n of nodes) n.innerHTML = `<div class="poll-err">${esc(e.message)}</div>`;
  }
}

// Optimistic: paint the new tally immediately, then let get_poll correct it.
// vote() only ever inserts for a multi poll, so a vote there cannot be taken
// back - say so rather than firing a request that silently does nothing.
async function castVote(pollId, optionId) {
  const poll = cache.get(pollId);
  if (!poll || isClosed(poll)) return;
  const mine = new Set(poll.my_votes || []);

  if (poll.multi && mine.has(optionId)) {
    toastFn?.('On a pick-many poll a vote cannot be taken back', 'info');
    return;
  }

  const before = JSON.parse(JSON.stringify(poll));
  const next = JSON.parse(JSON.stringify(poll));
  if (!next.multi) {
    // single choice: the server deletes my previous vote first
    for (const o of next.options) if (mine.has(o.id)) o.count = Math.max(0, (+o.count || 0) - 1);
    next.my_votes = [optionId];
    if (!mine.size) next.total_voters = (next.total_voters || 0) + 1;
  } else {
    next.my_votes = [...mine, optionId];
    if (!mine.size) next.total_voters = (next.total_voters || 0) + 1;
  }
  for (const o of next.options) if (o.id === optionId) o.count = (+o.count || 0) + 1;

  cache.set(pollId, next);
  for (const n of document.querySelectorAll(`.poll-card[data-poll="${CSS.escape(pollId)}"]`)) {
    paintCard(n, next);
  }

  try {
    await api.vote(pollId, [optionId]);
  } catch (e) {
    cache.set(pollId, before);
    for (const n of document.querySelectorAll(`.poll-card[data-poll="${CSS.escape(pollId)}"]`)) {
      paintCard(n, before);
    }
    toastErr(e);
    return;
  }
  repaint(pollId, true);
}

// ------------------------------------------------------------------ mounting
function mount(msg, row) {
  const pollId = msg?.body?.poll_id;
  if (!pollId || msg?.body?.type !== 'poll') return;
  if (row.dataset.pollMounted === pollId) return;
  row.dataset.pollMounted = pollId;

  const bodyEl = row.querySelector('.body');
  if (!bodyEl) return;
  const card = el('div', 'poll-card');
  card.dataset.poll = pollId;
  card.innerHTML = '<div class="muted">loading poll…</div>';
  bodyEl.innerHTML = '';
  bodyEl.appendChild(card);

  loadPoll(pollId)
    .then((p) => paintCard(card, p))
    .catch((e) => { card.innerHTML = `<div class="poll-err">${esc(e.message)}</div>`; });
}

// ------------------------------------------------------------------ compose
async function pollDialog(ui, prefill = {}) {
  if (!store.current) { ui.toast('Open a channel first - polls live in a channel', 'error'); return; }
  const fields = [
    { name: 'question', label: 'Question', required: true, value: prefill.question || '',
      placeholder: 'What should we do?' },
  ];
  for (let i = 0; i < MAX_FORM_OPTIONS; i++) {
    fields.push({
      name: 'o' + i,
      label: i < 2 ? `Option ${i + 1}` : `Option ${i + 1} (optional)`,
      value: prefill.options?.[i] || '',
      required: i < 2,
    });
  }
  fields.push({ name: 'multi', label: 'Let people pick more than one', type: 'checkbox', value: false });
  fields.push({
    name: 'closes', label: 'Close automatically at (optional)', type: 'datetime-local',
    hint: 'Leave blank to keep it open until you close it by hand.',
  });

  const out = await ui.formModal({
    title: 'New poll in #' + store.current.name,
    fields,
    submitLabel: 'Post poll',
    note: 'Everyone in the channel can vote. Results are visible as soon as you vote.',
  });
  if (!out) return;

  const options = [];
  for (let i = 0; i < MAX_FORM_OPTIONS; i++) {
    const v = (out['o' + i] || '').trim();
    if (v) options.push(v);
  }
  if (options.length < 2) { ui.toast('A poll needs at least two options', 'error'); return; }

  let closesAt = null;
  if (out.closes) {
    closesAt = fromLocalInput(out.closes);
    if (new Date(closesAt).getTime() <= Date.now()) {
      ui.toast('The closing time has to be in the future', 'error');
      return;
    }
  }

  try {
    // The card mounts from the message create_poll posts, so nothing to render
    // here - just make sure a stale tally is not reused if the id ever repeats.
    const poll = await api.createPoll(store.current.id, out.question.trim(), options, !!out.multi, closesAt);
    if (poll?.id) cache.delete(poll.id);
    ui.toast('Poll posted', 'success');
  } catch (e) {
    ui.toast(e.message, 'error');
  }
}

// `/poll Lunch? | Dosa | Thali` prefills the dialog instead of posting blind, so
// a typo is still fixable before anyone sees it.
function parseSlash(argText) {
  const parts = (argText || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return {};
  return { question: parts[0], options: parts.slice(1) };
}

// ------------------------------------------------------------------ realtime
// Core owns the 'chan' subscription and rebuilds it on every channel switch, so
// we bind our extra broadcast onto whatever object is current and re-bind when
// core swaps it. Bounded retries, because channel:open fires before subscribe().
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'poll_update' }, ({ payload }) => {
    if (payload?.poll_id) repaint(payload.poll_id, true);
  });
  return true;
}
function scheduleBind() {
  clearInterval(rebind);
  let tries = 0;
  rebind = setInterval(() => {
    if (bindChannel() || ++tries > 20) clearInterval(rebind);
  }, 400);
}

// ------------------------------------------------------------------ styles
function injectStyles() {
  if (document.getElementById('poll-styles')) return;
  const s = el('style');
  s.id = 'poll-styles';
  s.textContent = `
.poll-card{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:2px 0;
  background:var(--panel2);max-width:520px}
.poll-card.poll-closed{opacity:.9}
.poll-head{display:flex;align-items:flex-start;gap:8px}
.poll-q{flex:1;font-weight:700;word-break:break-word}
.poll-tag{flex:none;font-size:9.5px;font-weight:800;letter-spacing:.5px;padding:2px 6px;
  border-radius:4px;background:var(--panel3);color:var(--dim)}
.poll-opts{display:flex;flex-direction:column;gap:5px;margin:9px 0 7px}
.poll-opt{position:relative;display:flex;align-items:center;gap:7px;width:100%;overflow:hidden;
  text-align:left;background:var(--panel);border:1px solid var(--line);color:var(--text);
  border-radius:8px;padding:7px 10px;font-weight:500;font-size:13.5px}
.poll-opt:hover:not(:disabled){border-color:var(--accent)}
.poll-opt:disabled{opacity:1;cursor:default}
.poll-opt.mine{border-color:var(--accent)}
.poll-fill{position:absolute;left:0;top:0;bottom:0;background:#5b8cff22;transition:width .3s ease}
.poll-opt.mine .poll-fill{background:#5b8cff40}
.poll-tick{position:relative;width:12px;flex:none;color:var(--accent);font-size:12px}
.poll-txt{position:relative;flex:1;word-break:break-word}
.poll-num{position:relative;flex:none;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.poll-foot{display:flex;align-items:center;gap:8px;font-size:12px}
.poll-err{color:#ff9a8f;font-size:12.5px}
.poll-row-meta{display:flex;align-items:center;gap:6px;font-size:12px;margin-top:4px}
.poll-pill{font-size:10px;font-weight:800;letter-spacing:.4px;padding:1px 6px;border-radius:4px;
  background:var(--panel3);color:var(--dim)}
.poll-pill.open{background:#13251d;color:var(--green)}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  toastFn = ui.toast;
  injectStyles();

  bus.on('message:render', ({ msg, el: row }) => mount(msg, row));

  bus.on('channel:open', scheduleBind);
  bus.on('channel:subscribed', scheduleBind);
  scheduleBind();

  ui.addSlashCommand({
    name: 'poll',
    description: 'Post a poll - /poll Question? | option | option',
    run: (argText) => pollDialog(ui, parseSlash(argText)),
  });

  ui.addComposerButton({
    id: 'poll',
    label: icon('chart'),
    title: 'Create a poll',
    onClick: () => pollDialog(ui),
  });
  // initComposer() paints the tool row before features register, so ask for a
  // repaint rather than waiting for the next channel switch.
  ui.renderComposerButtons();

  ui.addHeaderButton({
    id: 'polls', label: icon('chart'), title: 'Polls', order: 75,
    onClick: () => ui.openPanel('polls'),
  });

  // There is no list_polls RPC, but the polls table is readable under RLS
  // (can_view_channel), so the panel enumerates it directly.
  ui.registerPanel({
    id: 'polls',
    title: 'Polls',
    async render(body) {
      body.innerHTML = '<div class="muted pad">loading…</div>';
      if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }

      let rows;
      try {
        rows = await table('polls', (q) =>
          q.eq('workspace_id', store.ws.id).order('created_at', { ascending: false }).limit(40));
      } catch (e) {
        body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
        return;
      }
      if (!rows.length) {
        body.innerHTML = `<div class="empty">No polls in this Space yet.<br>
          Post one with <code>/poll</code> or the 📊 button next to the composer and it will appear
          here while it is open.</div>`;
        return;
      }

      // Live tallies are per-poll; fetch the visible ones in parallel and let any
      // that fail fall back to the row from the table.
      const tallies = await Promise.all(rows.map((r) => tryRpc('get_poll', { p_poll: r.id })));
      rows.forEach((r, i) => { if (tallies[i][0]) cache.set(r.id, tallies[i][0]); });

      const open = rows.filter((r) => !isClosed(r));
      const done = rows.filter((r) => isClosed(r));

      body.innerHTML = '';
      const section = (title, list, emptyNote) => {
        body.appendChild(el('h4', 'sec', esc(title)));
        if (!list.length) { body.appendChild(el('div', 'empty', emptyNote)); return; }
        for (const r of list) {
          const live = cache.get(r.id);
          const ch = store.channels.find((c) => c.id === r.channel_id);
          const voters = live?.total_voters ?? 0;
          const card = el('div', 'result', `
            <div><b>${esc(r.question)}</b></div>
            <div class="poll-row-meta">
              <span class="poll-pill${isClosed(r) ? '' : ' open'}">${isClosed(r) ? 'CLOSED' : 'OPEN'}</span>
              <span class="muted">#${esc(ch?.name || 'private channel')} ·
                ${esc(nameOf(r.created_by))} · ${esc(relTime(r.created_at))} ·
                ${voters} ${voters === 1 ? 'voter' : 'voters'}</span>
            </div>`);
          card.title = 'Jump to this poll';
          card.onclick = () => {
            if (r.message_id) bus.emit('message:jump', { messageId: r.message_id });
            else if (r.channel_id) bus.emit('channel:request', { channelId: r.channel_id });
          };
          body.appendChild(card);
        }
      };
      section('Open', open, 'Nothing open right now.');
      section('Closed', done, 'No closed polls yet.');
    },
  });
}
