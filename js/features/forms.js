// Forms: one primitive for the paperwork an NGO actually runs on.
//
// A leave request, an expense claim, an incident report, new-volunteer intake and
// the weekly field update are the same shape: a titled list of typed questions,
// posted into a channel, answered once (or repeatedly), with the answers visible
// only to the person who asked and to Space admins.
//
// Deliberately NOT here: drag-and-drop builders (that is where this feature dies),
// approval chains and conditional branching (at 30 people the approver is in the
// room), and offline enumeration for real field surveys - KoboToolbox and ODK are
// free, built for humanitarian work, and already handle that. This is intake.
//
// The card mounts on the message create_form posts, exactly the way polls do, so a
// form reads as part of the conversation rather than a link out to somewhere else.
import { rpc, tryRpc } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, fmt, relTime } from '../util.js';
import { icon } from '../icons.js';
import { getSub } from '../sb.js';

const CLS = 'frm';
const MAX_FIELDS = 20;
const cache = new Map();          // form_id -> get_form payload
let toastFn = null;

const TYPES = [
  { value: 'text', label: 'Short answer' },
  { value: 'textarea', label: 'Long answer' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Choose one' },
  { value: 'date', label: 'Date' },
  { value: 'checkbox', label: 'Yes / no' },
];
const typeLabel = (t) => TYPES.find((x) => x.value === t)?.label || t;

function humanError(e) {
  const m = String(e?.message || '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. Try again when you are back online.';
  if (/already_submitted/i.test(m)) return 'You have already answered this one.';
  if (/form_closed/i.test(m)) return 'This form is closed.';
  if (/missing_required_field/i.test(m)) return 'Please fill in every question marked required.';
  if (/not_a_number/i.test(m)) return 'One of the number questions has something that is not a number in it.';
  if (/not_a_date/i.test(m)) return 'One of the date questions is not a valid date.';
  if (/invalid_option/i.test(m)) return 'Pick one of the listed options.';
  if (/answer_too_long/i.test(m)) return 'One of your answers is too long.';
  if (/forbidden/i.test(m)) return 'You do not have permission to do that.';
  if (/rate_limited/i.test(m)) return 'Slow down a moment, then try again.';
  return 'That did not work. Try again in a moment.';
}
const toastErr = (e) => toastFn?.(humanError(e), 'error');

async function load(id, force = false) {
  if (!force && cache.has(id)) return cache.get(id);
  const data = await rpc('get_form', { p_form: id });
  cache.set(id, data);
  return data;
}

// ------------------------------------------------------------------ card
function paintCard(host, f) {
  const answered = (f.my_submissions || []).length;
  const canAnswer = !f.closed && (f.multi || !answered);

  host.className = CLS + '-card' + (f.closed ? ' ' + CLS + '-closed' : '');
  host.dataset.form = f.id;
  host.innerHTML = `
    <div class="${CLS}-head">
      <div class="${CLS}-title">${esc(f.title)}</div>
      <span class="${CLS}-tag">${f.closed ? 'CLOSED' : 'FORM'}</span>
    </div>
    ${f.description ? `<div class="${CLS}-desc">${fmt(f.description)}</div>` : ''}
    <div class="${CLS}-qs">${(f.fields || []).length} question${(f.fields || []).length === 1 ? '' : 's'}
      · ${f.responder_count || 0} ${f.responder_count === 1 ? 'person has' : 'people have'} answered</div>
    <div class="${CLS}-foot row gap"></div>`;

  const foot = host.querySelector('.' + CLS + '-foot');

  if (canAnswer) {
    const b = el('button', CLS + '-fill', answered ? 'Answer again' : 'Fill this in');
    b.type = 'button';
    b.onclick = (ev) => { ev.stopPropagation(); fillDialog(f.id); };
    foot.appendChild(b);
  } else if (answered) {
    const when = relTime(f.my_submissions[f.my_submissions.length - 1].created_at);
    foot.appendChild(el('span', CLS + '-done', icon('check') + ` You answered ${esc(when)}`));
  } else if (f.closed) {
    foot.appendChild(el('span', 'muted', 'No longer accepting answers'));
  }

  if (f.can_view_responses) {
    const v = el('button', 'sm ghost', `See answers (${f.response_count || 0})`);
    v.type = 'button';
    v.onclick = (ev) => { ev.stopPropagation(); openResponses(f.id); };
    foot.appendChild(v);

    const isMine = f.created_by === store.me;
    if (isMine || hasPerm(PERM.MANAGE_MESSAGES)) {
      const c = el('button', 'sm ghost', f.closed ? 'Reopen' : 'Close');
      c.type = 'button';
      c.onclick = async (ev) => {
        ev.stopPropagation();
        c.disabled = true;
        try { await rpc('close_form', { p_form: f.id, p_closed: !f.closed }); await repaint(f.id, true); }
        catch (e) { c.disabled = false; toastErr(e); }
      };
      foot.appendChild(c);
    }
  }
}

async function repaint(id, force = false) {
  const nodes = document.querySelectorAll(`.${CLS}-card[data-form="${CSS.escape(id)}"]`);
  if (!nodes.length) { if (force) cache.delete(id); return; }
  try {
    const f = await load(id, force);
    for (const n of nodes) paintCard(n, f);
  } catch (e) {
    for (const n of nodes) n.innerHTML = `<div class="${CLS}-err">${esc(humanError(e))}</div>`;
  }
}

function mount(msg, row) {
  const id = msg?.body?.form_id;
  if (!id || msg?.body?.type !== 'form') return;
  if (row.dataset.formMounted === id) return;
  row.dataset.formMounted = id;

  const bodyEl = row.querySelector('.body');
  if (!bodyEl) return;
  const card = el('div', CLS + '-card');
  card.dataset.form = id;
  card.innerHTML = '<div class="muted">loading form…</div>';
  bodyEl.innerHTML = '';
  bodyEl.appendChild(card);

  load(id)
    .then((f) => paintCard(card, f))
    .catch((e) => { card.innerHTML = `<div class="${CLS}-err">${esc(humanError(e))}</div>`; });
}

// ------------------------------------------------------------------ filling in
// Built with ui.formModal so it inherits the shell's keyboard handling, required
// checks and mobile layout rather than reinventing a form inside a form.
async function fillDialog(id) {
  let f;
  try { f = await load(id, true); } catch (e) { toastErr(e); return; }
  if (f.closed) { toastFn?.('This form is closed.', 'error'); return; }

  const fields = (f.fields || []).map((q) => {
    const base = { name: q.key, label: q.label + (q.required ? ' *' : ''), required: !!q.required };
    if (q.type === 'textarea') return { ...base, type: 'textarea', rows: 4 };
    if (q.type === 'number') return { ...base, type: 'number' };
    if (q.type === 'date') return { ...base, type: 'date' };
    if (q.type === 'checkbox') return { ...base, type: 'checkbox', required: false, value: false };
    if (q.type === 'select') {
      return { ...base, type: 'select', options: [{ value: '', label: 'Choose…' }, ...q.options.map((o) => ({ value: o, label: o }))] };
    }
    return { ...base, type: 'text' };
  });

  const out = await uiRef.formModal({
    title: f.title,
    fields,
    submitLabel: 'Send',
    wide: fields.length > 4,
    note: f.description ? '' : 'Your answer is visible only to whoever created this form and to Space admins.',
  });
  if (!out) return;

  const answers = {};
  for (const q of f.fields || []) {
    const v = out[q.key];
    if (q.type === 'checkbox') answers[q.key] = v ? 'true' : 'false';
    else if (v != null && String(v).trim() !== '') answers[q.key] = String(v);
  }

  try {
    await rpc('submit_form', { p_form: id, p_answers: answers });
    toastFn?.('Sent. Thank you.', 'success');
    await repaint(id, true);
  } catch (e) { toastErr(e); }
}

// ------------------------------------------------------------------ responses
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function openResponses(id) { uiRef.openPanel('form-responses', { formId: id }); }

async function renderResponses(body, ctx = {}) {
  const id = ctx.formId;
  if (!id) { body.innerHTML = '<div class="empty">Open a form to see its answers.</div>'; return; }
  body.innerHTML = '<div class="muted pad">loading…</div>';

  let f, rows;
  try {
    f = await load(id, true);
    rows = await rpc('list_form_submissions', { p_form: id });
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(humanError(e))}</div>`;
    return;
  }

  body.innerHTML = '';
  body.appendChild(el('h4', 'sec', esc(f.title)));

  if (!rows.length) {
    body.appendChild(el('div', 'empty',
      'Nobody has answered yet. The form is posted in the channel - '
      + 'reply there to nudge people, or use <b>Ask everyone to confirm</b> on the post.'));
    return;
  }

  const cols = f.fields || [];

  // One card per response reads far better on a phone than a wide table that has
  // to scroll sideways, and this audience is on phones.
  for (const r of rows) {
    const card = el('div', 'result ' + CLS + '-resp');
    let h = `<div class="${CLS}-respwho"><b>${esc(nameOf(r.user_id))}</b>
      <span class="muted">${esc(relTime(r.created_at))}</span></div>`;
    for (const c of cols) {
      const raw = r.answers?.[c.key];
      const shown = raw === true ? 'Yes' : raw === false ? 'No' : raw == null || raw === '' ? '-' : String(raw);
      h += `<div class="${CLS}-pair"><span class="${CLS}-k">${esc(c.label)}</span>
        <span class="${CLS}-v">${esc(shown)}</span></div>`;
    }
    card.innerHTML = h;
    body.appendChild(card);
  }
}

function responsesFooter(foot, ctx = {}) {
  const id = ctx.formId;
  const btn = el('button', 'sm', 'Download as CSV');
  btn.onclick = async () => {
    try {
      const f = await load(id, true);
      const rows = await rpc('list_form_submissions', { p_form: id });
      const cols = f.fields || [];
      const head = ['Who', 'When', ...cols.map((c) => c.label)];
      const lines = [head.map(csvCell).join(',')];
      for (const r of rows) {
        lines.push([
          nameOf(r.user_id),
          new Date(r.created_at).toISOString(),
          ...cols.map((c) => {
            const v = r.answers?.[c.key];
            return v === true ? 'Yes' : v === false ? 'No' : v ?? '';
          }),
        ].map(csvCell).join(','));
      }
      // A BOM so Excel on a Windows machine opens Devanagari correctly.
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = (f.title || 'form').replace(/[^\w\d]+/g, '-').toLowerCase() + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toastErr(e); }
  };
  foot.appendChild(btn);
}

// ------------------------------------------------------------------ builder
// A field-row editor, not a drag-and-drop canvas. Six types, a required tick, and
// options for "choose one". That is the whole thing, and it fits on a phone.
function builderRow(i, seed = {}) {
  const row = el('div', CLS + '-brow');
  row.innerHTML = `
    <div class="${CLS}-bnum">${i + 1}</div>
    <input class="${CLS}-blabel" placeholder="Question" maxlength="200" value="${esc(seed.label || '')}">
    <select class="${CLS}-btype">
      ${TYPES.map((t) => `<option value="${t.value}"${seed.type === t.value ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
    </select>
    <label class="${CLS}-breq"><input type="checkbox"${seed.required ? ' checked' : ''}> Required</label>
    <input class="${CLS}-bopts" placeholder="Options, separated by commas" value="${esc((seed.options || []).join(', '))}">
    <button type="button" class="${CLS}-bdel icon" title="Remove this question" aria-label="Remove this question">${icon('close')}</button>`;

  const type = row.querySelector('.' + CLS + '-btype');
  const opts = row.querySelector('.' + CLS + '-bopts');
  const syncOpts = () => { opts.style.display = type.value === 'select' ? '' : 'none'; };
  type.onchange = syncOpts;
  syncOpts();
  row.querySelector('.' + CLS + '-bdel').onclick = () => {
    // Capture the host BEFORE removing: afterwards row.parentElement is null, so
    // the renumber silently ran over an empty list and question 3 stayed "3" once
    // question 2 was gone.
    const host = row.parentElement;
    if (!host || host.children.length <= 1) { toastFn?.('A form needs at least one question', 'error'); return; }
    row.remove();
    [...host.children].forEach((n, k) => { n.querySelector('.' + CLS + '-bnum').textContent = k + 1; });
  };
  return row;
}

function readBuilder(host) {
  const out = [];
  for (const row of host.children) {
    const label = row.querySelector('.' + CLS + '-blabel').value.trim();
    if (!label) continue;
    const type = row.querySelector('.' + CLS + '-btype').value;
    const required = row.querySelector('.' + CLS + '-breq input').checked;
    const options = type === 'select'
      ? row.querySelector('.' + CLS + '-bopts').value.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    out.push({ label, type, required, options });
  }
  return out;
}

function newFormDialog(prefill = {}) {
  if (!store.current) { toastFn?.('Open a channel first - a form lives in a channel', 'error'); return; }

  const wrap = el('div', CLS + '-builder');
  wrap.innerHTML = `
    <label class="field"><span class="field-label">What is this for?</span>
      <input id="${CLS}-title" maxlength="200" placeholder="Leave request" value="${esc(prefill.title || '')}"></label>
    <label class="field"><span class="field-label">A line of explanation (optional)</span>
      <textarea id="${CLS}-desc" rows="2" placeholder="Fill this in before Friday so we can plan cover."></textarea></label>
    <h4 class="sec">Questions</h4>
    <div class="${CLS}-rows"></div>
    <div class="row gap">
      <button type="button" class="sm ghost" id="${CLS}-add">Add another question</button>
    </div>
    <label class="field field-check"><span class="field-label">Let one person answer more than once</span>
      <input type="checkbox" id="${CLS}-multi"></label>
    <p class="muted">Answers are visible only to you and to Space admins. Everyone in
      <b>#${esc(store.current.name)}</b> will see the form itself.</p>`;

  const rows = wrap.querySelector('.' + CLS + '-rows');
  const seeds = prefill.fields?.length ? prefill.fields : [{ type: 'text' }];
  seeds.forEach((s, i) => rows.appendChild(builderRow(i, s)));
  wrap.querySelector('#' + CLS + '-add').onclick = () => {
    if (rows.children.length >= MAX_FIELDS) { toastFn?.(`A form can have at most ${MAX_FIELDS} questions`, 'error'); return; }
    rows.appendChild(builderRow(rows.children.length));
  };

  uiRef.modal({
    title: 'New form in #' + store.current.name,
    body: wrap,
    wide: true,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (close) => close() },
      {
        label: 'Post form',
        onClick: async (close) => {
          const title = wrap.querySelector('#' + CLS + '-title').value.trim();
          const desc = wrap.querySelector('#' + CLS + '-desc').value.trim();
          const multi = wrap.querySelector('#' + CLS + '-multi').checked;
          const fields = readBuilder(rows);
          if (!title) { toastFn?.('Give the form a name', 'error'); return; }
          if (!fields.length) { toastFn?.('Add at least one question', 'error'); return; }
          const badSelect = fields.find((f) => f.type === 'select' && f.options.length < 2);
          if (badSelect) { toastFn?.(`"${badSelect.label}" needs at least two options`, 'error'); return; }
          try {
            const form = await rpc('create_form', {
              p_channel: store.current.id, p_title: title, p_desc: desc || null,
              p_fields: fields, p_multi: multi,
            });
            if (form?.id) cache.delete(form.id);
            close();
            toastFn?.('Form posted', 'success');
          } catch (e) { toastErr(e); }
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ list panel
async function renderList(body) {
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }

  const [rows, err] = await tryRpc('list_forms', { p_workspace: store.ws.id, p_open_only: false });
  if (err) { body.innerHTML = `<div class="empty">${esc(humanError(err))}</div>`; return; }
  if (!rows?.length) {
    const b = el('div', 'empty',
      'No forms yet. A form is how you collect the same few answers from everyone - '
      + 'a leave request, an expense claim, a weekly field report.<br><br>');
    const go = el('button', 'sm', 'Create a form in this channel');
    go.onclick = () => newFormDialog();
    b.appendChild(go);
    body.innerHTML = '';
    body.appendChild(b);
    return;
  }

  body.innerHTML = '';
  const open = rows.filter((r) => !r.closed);
  const done = rows.filter((r) => r.closed);

  const section = (title, list, empty) => {
    body.appendChild(el('h4', 'sec', esc(title)));
    if (!list.length) { body.appendChild(el('div', 'empty', esc(empty))); return; }
    for (const r of list) {
      const ch = store.channels.find((c) => c.id === r.channel_id);
      const card = el('div', 'result ' + CLS + '-row', `
        <div><b>${esc(r.title)}</b></div>
        <div class="${CLS}-meta muted">
          <span class="${CLS}-pill${r.closed ? '' : ' open'}">${r.closed ? 'CLOSED' : 'OPEN'}</span>
          #${esc(ch?.name || 'channel')} · ${esc(nameOf(r.created_by))} ·
          ${esc(relTime(r.created_at))} ·
          ${r.responder_count || 0} answered
        </div>`);
      card.title = 'Jump to this form';
      card.onclick = () => {
        if (r.message_id) bus.emit('message:jump', { messageId: r.message_id });
        else if (r.channel_id) bus.emit('channel:request', { channelId: r.channel_id });
      };
      if (r.can_view_responses) {
        const v = el('button', 'sm ghost', 'See answers');
        v.onclick = (e) => { e.stopPropagation(); openResponses(r.id); };
        card.appendChild(v);
      }
      body.appendChild(card);
    }
  };
  section('Open', open, 'Nothing open right now.');
  section('Closed', done, 'No closed forms yet.');
}

// ------------------------------------------------------------------ realtime
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'form_update' }, ({ payload }) => {
    if (payload?.form_id) repaint(payload.form_id, true);
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
.${CLS}-card{border:1px solid var(--c-border);border-radius:var(--r-lg);
  padding:var(--s-4) var(--s-5);margin:var(--s-1) 0;background:var(--c-surface-2);max-width:520px}
.${CLS}-card.${CLS}-closed{opacity:.92}
.${CLS}-head{display:flex;align-items:flex-start;gap:var(--s-4)}
.${CLS}-title{flex:1;font-weight:var(--t-bold);word-break:break-word}
/* Tint for the signal, --c-text for the label: --c-accent on --c-accent-quiet is
   3.72:1 in light and 4.08:1 in dark, both under AA at 10.5px. */
.${CLS}-tag{flex:none;font-size:var(--t-2xs);font-weight:var(--t-black);letter-spacing:.5px;
  padding:var(--s-1) var(--s-3);border-radius:var(--r-xs);
  background:var(--c-accent-quiet);color:var(--c-text)}
.${CLS}-closed .${CLS}-tag{background:var(--c-surface-3);color:var(--c-text-2)}
.${CLS}-desc{color:var(--c-text-2);font-size:var(--t-sm);margin-top:var(--s-2)}
.${CLS}-qs{color:var(--c-text-2);font-size:var(--t-xs);margin:var(--s-3) 0 var(--s-4)}
.${CLS}-foot{flex-wrap:wrap;align-items:center;gap:var(--s-3)}
/* --c-text-inverse, not --c-accent-text: the latter is white in every theme and
   lands at 3.16:1 on the dark accent. */
.${CLS}-fill{min-height:36px;padding:var(--s-3) var(--s-6);border-radius:var(--r-md);border:0;
  font-weight:var(--t-semibold);background:var(--c-accent);color:var(--c-text-inverse)}
/* polish.css section 16 carries
     :root[data-theme="light"] .frm-fill { color: color-mix(in srgb, var(--c-accent) 88%, black) }
   which reads .frm-fill as accent-coloured TEXT. It is a filled accent BUTTON, so
   that rule paints dark blue on blue: measured 1.23:1 (light) and 1.20:1
   (colorful), i.e. the primary call to action on a form is unreadable in the two
   themes most likely to be used outdoors. That file belongs to another agent and
   is loaded LAST (it is appended to <head> after every feature <style>), so equal
   specificity loses on order - hence the element selector, which takes this to
   (0,3,1) and wins without !important. The rule there should be deleted.
   .ackl-confirm is built identically and has no such override, which is what made
   the two buttons disagree. */
:root[data-theme="light"] button.${CLS}-fill,
:root[data-theme="colorful"] button.${CLS}-fill{color:var(--c-text-inverse)}
.${CLS}-done{display:inline-flex;align-items:center;gap:var(--s-2);
  color:var(--c-text-2);font-size:var(--t-sm);font-weight:var(--t-semibold)}
.${CLS}-done svg{width:15px;height:15px;color:var(--c-success)}
.${CLS}-err{color:var(--c-danger);font-size:var(--t-sm)}

.${CLS}-resp{margin-bottom:var(--s-3)}
.${CLS}-respwho{display:flex;gap:var(--s-3);align-items:baseline;margin-bottom:var(--s-3)}
.${CLS}-pair{display:flex;gap:var(--s-4);padding:var(--s-2) 0;border-top:1px solid var(--c-border-subtle)}
.${CLS}-k{flex:0 0 40%;color:var(--c-text-2);font-size:var(--t-sm)}
.${CLS}-v{flex:1;word-break:break-word;font-size:var(--t-sm)}

.${CLS}-row{cursor:pointer}
.${CLS}-meta{display:flex;flex-wrap:wrap;gap:var(--s-2);align-items:center;
  font-size:var(--t-xs);margin-top:var(--s-2)}
.${CLS}-pill{font-size:var(--t-2xs);font-weight:var(--t-black);letter-spacing:.4px;
  padding:var(--s-0) var(--s-3);border-radius:var(--r-xs);
  background:var(--c-surface-3);color:var(--c-text-2)}
.${CLS}-pill.open{background:var(--c-success-quiet);color:var(--c-text)}

.${CLS}-builder .${CLS}-rows{display:flex;flex-direction:column;gap:var(--s-3)}
.${CLS}-brow{display:grid;gap:var(--s-3);align-items:center;
  grid-template-columns:22px minmax(0,1fr) minmax(0,140px) auto 36px;
  padding:var(--s-3);border:1px solid var(--c-border-subtle);border-radius:var(--r-md)}
.${CLS}-bnum{color:var(--c-text-3);font-size:var(--t-sm);text-align:center}
.${CLS}-bopts{grid-column:2 / -1}
.${CLS}-breq{display:flex;align-items:center;gap:var(--s-2);
  font-size:var(--t-sm);color:var(--c-text-2);white-space:nowrap}
.${CLS}-bdel{min-width:36px;min-height:36px}
@media (max-width: 720px){
  .${CLS}-brow{grid-template-columns:22px minmax(0,1fr) 36px}
  .${CLS}-btype{grid-column:2}
  .${CLS}-breq{grid-column:2}
  .${CLS}-bdel{grid-row:1;grid-column:3}
}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
let uiRef = null;

export function register({ ui }) {
  uiRef = ui;
  toastFn = ui.toast;
  style();

  bus.on('message:render', ({ msg, el: row }) => mount(msg, row));
  bus.on('channel:open', scheduleBind);
  bus.on('channel:subscribed', scheduleBind);
  scheduleBind();

  ui.registerPanel({ id: 'forms', title: 'Forms', render: renderList });
  ui.registerPanel({
    id: 'form-responses',
    title: 'Answers',
    render: renderResponses,
    footer: responsesFooter,
  });

  ui.addHeaderButton({
    id: 'forms', label: icon('doc'), title: 'Forms', order: 76,
    onClick: () => ui.openPanel('forms', {}),
  });

  ui.addComposerButton({
    id: 'form', label: icon('doc'), title: 'Create a form',
    onClick: () => newFormDialog(),
  });
  // initComposer() paints the tool row before features register.
  ui.renderComposerButtons();

  ui.addSlashCommand({
    name: 'form',
    description: 'Collect the same answers from everyone - /form Leave request',
    run: (argText) => newFormDialog({ title: (argText || '').trim() }),
  });

  ui.addSwitcherSource({
    id: 'forms',
    search: (q) => {
      if (!/^f|form/i.test(q) && q.length < 2) return [];
      return [{
        label: 'New form',
        hint: 'Collect answers from everyone in this channel',
        icon: icon('doc'),
        run: () => newFormDialog(),
      }];
    },
  });
}
