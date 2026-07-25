// Acknowledgement that closes the loop.
//
// The product already had "who acknowledged this". For a 30-person NGO the useful
// question is the inverse: WHO HAS NOT. "Camp moved to Sunday, 6am" is worthless
// as a broadcast; it is worth something when the coordinator can see that Sunita
// and Imran have not seen it and can ring them.
//
// require_ack (0055) freezes the audience at the moment of asking, so the
// denominator means something a week later. This module is the surface: a card on
// the message showing "24 of 31 confirmed", a Confirm button for the people who
// owe an answer, the pending list by name, and one Chase button that pings only
// the non-responders.
//
// messageExtras.js already paints a small acknowledgement strip on `urgent`
// messages. This card mounts only when the real ack_required flag is set, and it
// deliberately leads with the pending side rather than repeating the acked list.
import { rpc, tryRpc } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, relTime } from '../util.js';
import { icon } from '../icons.js';
import { getSub } from '../sb.js';

const CLS = 'ackl';
const cache = new Map();           // message_id -> ack_status payload
let toastFn = null;

const toastErr = (e) => toastFn?.(humanError(e), 'error');

// Never show a volunteer a Postgres error code or "TypeError: Failed to fetch".
function humanError(e) {
  const m = String(e?.message || '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. It will work when you are back online.';
  if (/rate_limited/i.test(m)) return 'You have chased this a few times already. Give it a few minutes.';
  if (/forbidden/i.test(m)) return 'Only the person who posted this, or an admin, can do that.';
  if (/not_found/i.test(m)) return 'That message is gone.';
  return 'That did not work. Try again in a moment.';
}

// ------------------------------------------------------------------ data
async function load(id, force = false) {
  if (!force && cache.has(id)) return cache.get(id);
  const data = await rpc('ack_status', { p_message: id });
  cache.set(id, data);
  return data;
}

// ------------------------------------------------------------------ card
function paint(host, st) {
  const total = st.audience || 0;
  const done = st.acked_count || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const pending = st.pending || [];

  host.className = CLS + '-card' + (total && done >= total ? ' ' + CLS + '-all' : '');
  host.dataset.ackl = st.message_id;
  host.innerHTML = `
    <div class="${CLS}-head">
      <span class="${CLS}-tag">NEEDS CONFIRMING</span>
      <span class="${CLS}-count">${done} of ${total} confirmed</span>
    </div>
    <div class="${CLS}-bar"><span style="width:${pct}%"></span></div>
    <div class="${CLS}-pending"></div>
    <div class="${CLS}-foot row gap"></div>`;

  // Who has not answered. Names, not a number - the point is that you can ring them.
  const pendHost = host.querySelector('.' + CLS + '-pending');
  if (!pending.length) {
    pendHost.innerHTML = total
      ? `<span class="${CLS}-ok">Everyone has confirmed.</span>`
      : `<span class="muted">Nobody was in the channel when this was posted.</span>`;
  } else {
    const names = pending.slice(0, 8).map((p) => esc(nameOf(p.user_id))).join(', ');
    const more = pending.length > 8 ? ` and ${pending.length - 8} more` : '';
    pendHost.innerHTML = `<span class="${CLS}-waiting">Waiting on:</span> ${names}${more}`;
  }

  const foot = host.querySelector('.' + CLS + '-foot');

  // The person who owes an answer gets the one button that matters.
  if (st.i_am_target && !st.i_acked) {
    const b = el('button', CLS + '-confirm', 'Got it');
    b.type = 'button';
    b.onclick = async (ev) => {
      ev.stopPropagation();
      b.disabled = true;
      b.textContent = 'Sending…';
      try {
        await rpc('ack_message', { p_message: st.message_id });
        await repaint(st.message_id, true);
      } catch (e) { b.disabled = false; b.textContent = 'Got it'; toastErr(e); }
    };
    foot.appendChild(b);
  } else if (st.i_acked) {
    foot.appendChild(el('span', CLS + '-done', icon('check') + ' You confirmed this'));
  }

  // The author (or a moderator) gets the chase.
  if (st.can_chase && pending.length) {
    const c = el('button', 'sm ghost', `Remind the ${pending.length} who have not`);
    c.type = 'button';
    c.onclick = async (ev) => {
      ev.stopPropagation();
      c.disabled = true;
      try {
        const n = await rpc('chase_acks', { p_message: st.message_id });
        toastFn?.(n === 1 ? 'Reminded 1 person' : `Reminded ${n} people`, 'success');
        await repaint(st.message_id, true);
      } catch (e) { c.disabled = false; toastErr(e); }
    };
    foot.appendChild(c);
  }
}

async function repaint(id, force = false) {
  const nodes = document.querySelectorAll(`.${CLS}-card[data-ackl="${CSS.escape(id)}"]`);
  if (!nodes.length) { if (force) cache.delete(id); return; }
  try {
    const st = await load(id, force);
    for (const n of nodes) paint(n, st);
  } catch (e) {
    for (const n of nodes) n.innerHTML = `<div class="${CLS}-err">${esc(humanError(e))}</div>`;
  }
}

// message:render hands us the row; append the card under the body rather than
// replacing it, because unlike a poll the message text is still the content.
function mount(msg, row) {
  if (!msg?.id || !msg.ack_required) return;
  if (row.dataset.acklMounted === msg.id) return;
  row.dataset.acklMounted = msg.id;

  // Core rewrites row.dataset.id when the server answers an optimistic send but
  // never re-emits message:render, so a card stamped with the client nonce would
  // never repaint. Drop any card carrying a different id before adding this one.
  row.querySelectorAll('.' + CLS + '-card').forEach((n) => {
    if (n.dataset.ackl !== msg.id) n.remove();
  });

  const body = row.querySelector('.body') || row;
  const card = el('div', CLS + '-card');
  card.dataset.ackl = msg.id;
  card.innerHTML = '<span class="muted">checking who has confirmed…</span>';
  body.appendChild(card);

  load(msg.id)
    .then((st) => paint(card, st))
    .catch((e) => { card.innerHTML = `<div class="${CLS}-err">${esc(humanError(e))}</div>`; });
}

// ------------------------------------------------------------------ panel
async function renderPanel(body) {
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }
  if (!hasPerm(PERM.MANAGE_WORKSPACE)) {
    body.innerHTML = `<div class="empty">This is for Space admins.<br>
      It lists every announcement that asked for confirmation and shows who has not
      answered yet. Ask an admin of this Space if you need it.</div>`;
    return;
  }

  const [rows, err] = await tryRpc('admin_ack_report', { p_workspace: store.ws.id, p_limit: 50 });
  if (err) { body.innerHTML = `<div class="empty">${esc(humanError(err))}</div>`; return; }
  if (!rows?.length) {
    body.innerHTML = `<div class="empty">Nothing is waiting on a confirmation.<br>
      To ask for one, open a message's <b>${esc('...')}</b> menu and pick
      <b>Ask everyone to confirm</b>. You will then see exactly who has not read it.</div>`;
    return;
  }

  body.innerHTML = '';
  const outstanding = rows.filter((r) => Number(r.acked) < Number(r.audience));
  const settled = rows.filter((r) => Number(r.acked) >= Number(r.audience));

  const section = (title, list, empty) => {
    body.appendChild(el('h4', 'sec', esc(title)));
    if (!list.length) { body.appendChild(el('div', 'empty', esc(empty))); return; }
    for (const r of list) {
      const total = Number(r.audience) || 0;
      const done = Number(r.acked) || 0;
      const card = el('div', 'result ' + CLS + '-row', `
        <div class="${CLS}-rowtop">
          <b>${done} of ${total}</b>
          <span class="muted">#${esc(r.channel_name || 'channel')} ·
            ${esc(nameOf(r.author_id))} · ${esc(relTime(r.created_at))}</span>
        </div>
        <div class="${CLS}-bar"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div>
        <div class="${CLS}-text">${esc(r.body_text || '')}</div>`);
      card.title = 'Jump to this announcement';
      card.onclick = () => bus.emit('message:jump', { messageId: r.message_id });
      body.appendChild(card);
    }
  };
  section('Still waiting', outstanding, 'Nothing outstanding.');
  section('Everyone confirmed', settled, 'Nothing fully confirmed yet.');
}

// ------------------------------------------------------------------ realtime
// Core owns the 'chan' subscription and rebuilds it on every channel switch, so
// bind onto whatever object is current and re-bind when core swaps it.
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'ack' }, ({ payload }) => {
    if (payload?.message_id) repaint(payload.message_id, true);
  });
  ch.on('broadcast', { event: 'ack_required' }, ({ payload }) => {
    if (payload?.message_id) repaint(payload.message_id, true);
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
.${CLS}-card{margin:var(--s-3) 0 var(--s-1);padding:var(--s-4) var(--s-5);max-width:520px;
  border:1px solid var(--c-border);border-left:3px solid var(--c-warn);
  border-radius:var(--r-lg);background:var(--c-surface-2);font-size:var(--t-sm)}
.${CLS}-card.${CLS}-all{border-left-color:var(--c-success)}
.${CLS}-head{display:flex;align-items:center;gap:var(--s-4);flex-wrap:wrap}
/* The tint carries the meaning; the label carries the text. --c-warn as a
   FOREGROUND measures 3.08:1 (light) and 2.83:1 (colorful) against surface-2 and
   fails AA at 10.5px, so the label takes --c-text (10-14:1 in all three) and the
   colour signal stays in the background tint and the card's left border. */
.${CLS}-tag{font-size:var(--t-2xs);font-weight:var(--t-black);letter-spacing:.5px;
  padding:var(--s-1) var(--s-3);border-radius:var(--r-xs);
  background:var(--c-warn-quiet);color:var(--c-text)}
.${CLS}-all .${CLS}-tag{background:var(--c-success-quiet);color:var(--c-text)}
.${CLS}-count{font-weight:var(--t-bold);color:var(--c-text)}
.${CLS}-bar{height:5px;border-radius:var(--r-full);background:var(--c-surface-3);
  overflow:hidden;margin:var(--s-3) 0}
.${CLS}-bar>span{display:block;height:100%;background:var(--c-warn);transition:width var(--m-base) var(--m-ease)}
.${CLS}-all .${CLS}-bar>span{background:var(--c-success)}
.${CLS}-pending{color:var(--c-text-2);word-break:break-word;line-height:var(--t-snug)}
.${CLS}-waiting{font-weight:var(--t-semibold);color:var(--c-text)}
.${CLS}-ok{color:var(--c-text);font-weight:var(--t-semibold)}
.${CLS}-foot{margin-top:var(--s-4);flex-wrap:wrap;align-items:center}
.${CLS}-confirm{min-height:36px;padding:var(--s-3) var(--s-6);border-radius:var(--r-md);
/* --c-accent-text is white in every theme and lands at 3.16:1 on the dark accent.
   --c-text-inverse is the token the shell's own primary button uses and clears AA
   in all three (5.73 / 4.55 / 6.22). */
  font-weight:var(--t-semibold);background:var(--c-accent);color:var(--c-text-inverse);border:0}
.${CLS}-confirm:disabled{opacity:.6}
.${CLS}-done{display:inline-flex;align-items:center;gap:var(--s-2);color:var(--c-text-2);
  font-weight:var(--t-semibold)}
.${CLS}-done svg{width:15px;height:15px;color:var(--c-success)}
.${CLS}-err{color:var(--c-danger)}
.${CLS}-row{cursor:pointer}
.${CLS}-rowtop{display:flex;align-items:baseline;gap:var(--s-3);flex-wrap:wrap}
.${CLS}-text{color:var(--c-text-2);font-size:var(--t-sm);word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  toastFn = ui.toast;
  style();

  bus.on('message:render', ({ msg, el: row }) => mount(msg, row));
  bus.on('channel:open', scheduleBind);
  bus.on('channel:subscribed', scheduleBind);
  scheduleBind();

  // A reminder that arrives while the app is open should light up the card, not
  // wait for the next channel switch.
  bus.on('ack:chased', ({ messageId }) => repaint(messageId, true));

  ui.addMessageAction({
    id: 'require-ack',
    label: icon('megaphone'),
    title: 'Ask everyone to confirm',
    order: 46,
    contexts: ['channel'],
    // The server refuses this on someone else's message without MANAGE_MESSAGES,
    // so do not offer a button that is only going to error.
    show: (m) => !!m.id && !m.conversation_id && !m.ack_required &&
      (m.author_id === store.me || hasPerm(PERM.MANAGE_MESSAGES)),
    onClick: async (m, ev) => {
      ev?.stopPropagation?.();
      const ok = await ui.confirmModal({
        title: 'Ask everyone to confirm?',
        body: 'Everyone who can see this channel right now will be asked to tap '
          + '"Got it". You will see exactly who has not answered, and you can remind '
          + 'just those people with one tap. Anyone who joins later is not counted.',
        confirmLabel: 'Ask for confirmation',
      });
      if (!ok) return;
      try {
        const out = await rpc('require_ack', { p_message: m.id });
        m.ack_required = true;
        cache.delete(m.id);
        ui.toast(`Asked ${out.audience} ${out.audience === 1 ? 'person' : 'people'} to confirm`, 'success');
        // Paint immediately on the row that is already on screen.
        const row = document.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`);
        if (row) { delete row.dataset.acklMounted; mount(m, row); }
      } catch (e) { toastErr(e); }
    },
  });

  ui.registerPanel({ id: 'ack-report', title: 'Confirmations', render: renderPanel });

  ui.addHeaderButton({
    id: 'ack-report', label: icon('megaphone'), title: 'Confirmations', order: 78,
    show: () => hasPerm(PERM.MANAGE_WORKSPACE),
    onClick: () => ui.openPanel('ack-report', {}),
  });
}
