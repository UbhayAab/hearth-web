// The composer: autocomplete (@people, #channels, :emoji, /commands), attachments,
// server-synced drafts, typing broadcast, and optimistic send.
import { api } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { getSub } from '../sb.js';
import { $, el, esc, debounce, fmtSize } from '../util.js';
import { toast, listSlash, runSlash, renderComposerButtons } from '../ui.js';
import { uploadFile } from './media.js';
import { openEmojiPicker, searchEmoji } from './emoji.js';
import { appendMessage, claimMessage, scrollDown, upgradeMessageRow } from './messages.js';
import { icon } from '../icons.js';

let pending = [];          // attachments being/already uploaded
let ac = null;             // active autocomplete state

const composerEl = () => $('composer');

// ------------------------------------------------------------------ autocomplete
function acHide() {
  ac = null;
  const p = $('acPop');
  if (p) { p.classList.add('hidden'); p.innerHTML = ''; }
}

function acShow(items, onPick) {
  const p = $('acPop');
  if (!items.length) return acHide();
  ac = { items, index: 0, onPick };
  p.classList.remove('hidden');
  paintAc();
}

function paintAc() {
  const p = $('acPop');
  p.innerHTML = ac.items.map((it, i) =>
    `<div class="ac-row${i === ac.index ? ' sel' : ''}" data-i="${i}">
      ${it.icon ? `<span class="ac-ico">${it.icon}</span>` : ''}
      <span class="ac-label">${esc(it.label)}</span>
      ${it.hint ? `<span class="ac-hint">${esc(it.hint)}</span>` : ''}</div>`).join('');
  p.querySelectorAll('.ac-row').forEach((n) => {
    n.onmousedown = (e) => { e.preventDefault(); ac.onPick(ac.items[+n.dataset.i]); };
  });
}

function replaceToken(re, text) {
  const c = composerEl();
  const before = c.value.slice(0, c.selectionStart);
  const after = c.value.slice(c.selectionStart);
  const replaced = before.replace(re, text);
  c.value = replaced + after;
  const pos = replaced.length;
  c.focus();
  c.setSelectionRange(pos, pos);
  acHide();
  autogrow();
}

function updateAutocomplete() {
  const c = composerEl();
  const upto = c.value.slice(0, c.selectionStart);

  const slash = upto.match(/^\/(\w*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const cmds = listSlash().filter((s) => s.name.startsWith(q)).slice(0, 8);
    return acShow(cmds.map((s) => ({ label: '/' + s.name, hint: s.description, icon: '⌘', value: s })),
      (it) => replaceToken(/^\/(\w*)$/, '/' + it.value.name + ' '));
  }

  const at = upto.match(/(?:^|\s)@([\w.-]*)$/);
  if (at) {
    const q = at[1].toLowerCase();
    const people = [...store.profiles.values()]
      .filter((p) => p.id !== store.me)
      .filter((p) => !q || (p.display_name || '').toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q))
      .slice(0, 7)
      .map((p) => ({ label: p.display_name || p.username, hint: p.username ? '@' + p.username : '', icon: '👤',
        value: p.username || p.display_name }));
    const groups = [{ label: '@here', hint: 'notify everyone online', icon: '📣', value: 'here' },
      { label: '@channel', hint: 'notify the whole channel', icon: '📣', value: 'channel' }]
      .filter((g) => !q || g.label.slice(1).startsWith(q));
    const items = [...people, ...groups];
    if (items.length) return acShow(items, (it) => replaceToken(/(?:^|\s)@([\w.-]*)$/, (m) => m.replace(/@[\w.-]*$/, '@' + it.value + ' ')));
  }

  const hash = upto.match(/(?:^|\s)#([\w-]*)$/);
  if (hash) {
    const q = hash[1].toLowerCase();
    const chans = store.channels
      .filter((ch) => ch.kind !== 'voice' && (!q || ch.name.includes(q)))
      .slice(0, 7)
      .map((ch) => ({ label: '#' + ch.name, hint: ch.topic || '', icon: '#', value: ch.name }));
    if (chans.length) return acShow(chans, (it) => replaceToken(/(?:^|\s)#([\w-]*)$/, (m) => m.replace(/#[\w-]*$/, '#' + it.value + ' ')));
  }

  const emo = upto.match(/:([a-z0-9_+-]{2,})$/i);
  if (emo) {
    const found = searchEmoji(emo[1]).slice(0, 8)
      .map((e) => ({ label: `${e.ch}  ${e.name}`, icon: '', value: e.ch }));
    if (found.length) return acShow(found, (it) => replaceToken(/:([a-z0-9_+-]{2,})$/i, it.value + ' '));
  }

  acHide();
}

// ------------------------------------------------------------------ mentions
export function resolveMentions(text) {
  const out = [];
  const by = new Map();
  for (const p of store.profiles.values()) {
    if (p.username) by.set('@' + p.username.toLowerCase(), p.id);
    if (p.display_name) by.set('@' + p.display_name.toLowerCase(), p.id);
  }
  for (const t of text.match(/@[\w.-]+/g) || []) {
    const id = by.get(t.toLowerCase());
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}
bus.resolveMentions = resolveMentions;

export function mentionScope(text) {
  if (/(^|\s)@channel\b/.test(text)) return 'channel';
  if (/(^|\s)@here\b/.test(text)) return 'here';
  return 'none';
}

// ------------------------------------------------------------------ attachments
function renderChips() {
  const host = $('attachChips');
  if (!pending.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  host.classList.remove('hidden');
  host.innerHTML = pending.map((a, i) => `
    <div class="chip${a.uploading ? ' up' : ''}${a.failed ? ' failed' : ''}">
      <span>${(a.mime || '').startsWith('image/') ? '🖼' : (a.mime || '').startsWith('video/') ? '🎬' : '📄'}</span>
      <span class="chip-name">${esc(a.name || 'file')}</span>
      <span class="muted">${fmtSize(a.size || 0)}</span>
      ${a.uploading ? `<span class="chip-prog" style="width:${Math.round((a.progress || 0) * 100)}%"></span>` : ''}
      <span class="x" data-i="${i}">✕</span></div>`).join('');
  host.querySelectorAll('.x').forEach((x) => {
    x.onclick = () => { pending.splice(+x.dataset.i, 1); renderChips(); };
  });
}

export async function addFiles(files) {
  for (const f of files) {
    const stub = { name: f.name, mime: f.type, size: f.size, uploading: true, progress: 0 };
    pending.push(stub);
    renderChips();
    try {
      const a = await uploadFile(f, (p) => { stub.progress = p; renderChips(); });
      Object.assign(stub, a, { uploading: false });
    } catch (e) {
      stub.failed = true;
      stub.uploading = false;
      toast(`${f.name}: ${e.message}`, 'error');
      pending = pending.filter((x) => x !== stub);
    }
    renderChips();
  }
}

// ------------------------------------------------------------------ drafts
const saveDraft = debounce(() => {
  const c = composerEl();
  const scope = store.currentDM ? ['dm', store.currentDM] : store.current ? ['channel', store.current.id] : null;
  if (!scope) return;
  const text = c.value;
  store.drafts.set(scope[0] + ':' + scope[1], text);
  api.saveDraft(scope[0], scope[1], text).catch(() => {});
}, 900);

// ------------------------------------------------------------------ typing
// Typing was a heartbeat: one broadcast every 1.8s for as long as your fingers
// moved. Measured on a live two-client run, one 55-character sentence at adult
// thumb speed produced SIX broadcasts, each of them fanned out to every person
// with that channel open and billed per recipient. In a 300-person channel five
// simultaneous typists is 833 messages/second, over the Pro plan's 500/s cap -
// so the indicator, not the messages, is what takes the product down first.
//
// This is the state machine every other chat product uses instead: one edge on
// idle -> typing, one edge on typing -> idle, and a slow keepalive in between so
// a long message does not silently expire on the receiver. Two broadcasts for a
// normal sentence rather than one per 1.8 seconds of effort.
//
// The stop edge rides INSIDE the existing 'typing' event as a payload flag
// rather than as a new broadcast event, deliberately: the handler map for the
// typ: topic lives in channels.js, and a payload field needs no change there and
// no coordination with a client that has not reloaded yet. An old client sends
// no `state` and is read as a start, which is exactly what it means.
const TYPING_KEEPALIVE_MS = 10000;   // < the receiver's 12s expiry, so a real typist never flickers
const TYPING_IDLE_MS = 4000;         // fingers stopped: say so rather than let it time out
let typingOn = false;
let typingSentAt = 0;
let typingIdleTimer = null;

function sendTyping(state) {
  const sub = getSub('typing');
  if (!sub) return;
  sub.send({
    type: 'broadcast', event: 'typing',
    payload: { user_id: store.me, name: nameOf(store.me), state },
  });
}

export function stopTyping() {
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  if (!typingOn) return;
  typingOn = false;
  sendTyping('stop');
}

// Called on every keystroke. Almost all of them return without touching the
// socket, which is the point.
function emitTyping() {
  const c = composerEl();
  // Nothing in the box is not typing. Deleting back to empty must retract the
  // indicator, not keep publishing it.
  if (!c || !c.value.trim()) { stopTyping(); return; }
  // A hidden tab is a phone in a pocket or a laptop lid coming down. Anything it
  // publishes is fanned out to everyone and read by nobody.
  if (document.visibilityState === 'hidden') { stopTyping(); return; }

  const now = Date.now();
  if (!typingOn || now - typingSentAt >= TYPING_KEEPALIVE_MS) {
    typingOn = true;
    typingSentAt = now;
    sendTyping('start');
  }
  clearTimeout(typingIdleTimer);
  typingIdleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
}

// Switching channel replaces the 'typing' subscription under us, so there is no
// longer a socket to retract on. Drop the local state instead - the people still
// in the old channel expire the indicator on their own 12s timer.
function resetTyping() {
  clearTimeout(typingIdleTimer);
  typingIdleTimer = null;
  typingOn = false;
  typingSentAt = 0;
}

// ------------------------------------------------------------------ send
// The composer must not accept input before there is somewhere to send it.
// Without this, anything typed during the moment between a workspace switch and
// the first channel opening is sent to `undefined` and silently lost.
export function setComposerEnabled(on, reason) {
  const c = composerEl();
  if (!c) return;
  c.disabled = !on;
  c.placeholder = on ? c.dataset.ph || 'Message' : (reason || 'Pick a channel to start writing');
  $('sendBtn')?.toggleAttribute('disabled', !on);
  $('attachBtn')?.toggleAttribute('disabled', !on);
}

export async function send() {
  const c = composerEl();
  const text = c.value.trim();

  if (!store.current && !store.currentDM) {
    toast('Open a channel or a conversation first');
    return;
  }
  if (pending.some((a) => a.uploading)) { toast('Still uploading…'); return; }
  const atts = pending.filter((a) => a.object_key).map((a) => ({
    object_key: a.object_key, mime: a.mime, width: a.width, height: a.height,
    duration_ms: a.duration_ms, name: a.name, size: a.size,
  }));
  if (!text && !atts.length) return;

  if (text.startsWith('/') && !atts.length) {
    const handled = await runSlash(text);
    if (handled) { c.value = ''; autogrow(); acHide(); return; }
  }

  c.value = '';
  autogrow();
  acHide();
  // The message itself is about to arrive on their screen. Retract the indicator
  // in the same breath rather than leaving it to expire behind the message.
  stopTyping();
  pending = [];
  renderChips();

  const scope = store.currentDM ? ['dm', store.currentDM] : ['channel', store.current?.id];
  store.drafts.delete(scope[0] + ':' + scope[1]);
  api.deleteDraft(scope[0], scope[1]).catch(() => {});

  const nonce = crypto.randomUUID();
  store.seen.add('n:' + nonce);
  const optimistic = {
    id: nonce, client_msg_id: nonce, author_id: store.me, body_text: text,
    attachments: atts, created_at: new Date().toISOString(),
    reply_to_id: store.replyTarget?.id || null,
  };
  const row = appendMessage($('messages'), optimistic, store.currentDM ? 'dm' : 'channel');
  row.classList.add('pending');
  scrollDown();

  const replyTo = store.replyTarget?.id || null;
  clearReply();

  try {
    let data;
    if (store.currentDM) {
      data = await api.sendDM({ conversation: store.currentDM, nonce, text, attachments: atts, replyTo });
    } else {
      data = await api.send({
        channel: store.current.id, nonce, text, attachments: atts,
        mentions: resolveMentions(text), mentionScope: mentionScope(text), replyTo,
      });
    }
    if (data) {
      store.seen.add(data.id);
      // Only if it is the very next event. Jumping the cursor to my own seq
      // would step over anything published between my last applied event and
      // this send, and a cursor that has stepped over an event can never ask
      // for it again - that is precisely the bug gap detection exists to catch,
      // and the sender must not reintroduce it for themselves.
      if (!store.currentDM && data.seq === store.cursor + 1) store.cursor = data.seq;
      if (store.currentDM && data.seq === store.dmCursor + 1) store.dmCursor = data.seq;
      // Re-point the row that is already on screen at the real message. Not a
      // replacement: the optimistic node stays, so its grouping against the
      // message above it survives and nothing holding a reference to it (a
      // hover, a scroll anchor) is left on a detached element.
      upgradeMessageRow(row, data, store.currentDM ? 'dm' : 'channel');
      scrollDown();
    }
  } catch (e) {
    row.classList.remove('pending');
    // The durable outbox owns this row's story when it is running: it has
    // already queued the message, tagged the row, and painted a state strip
    // saying so. Painting a SECOND, different explanation on top of that - and
    // watching it get deleted 140ms later - is the opposite of calm. It also
    // told a lie: "not delivered" for a message that is on disk and will send.
    if (row.dataset.obNonce || row.querySelector('.ob-state')) return;

    // No outbox: this row is on its own, so explain it here. Quietly - the
    // message is still there, still readable, and one button fixes it.
    row.classList.add('failed');
    const mbody = row.querySelector('.mbody') || row;
    row.querySelector('.send-state')?.remove();
    const strip = el('div', 'send-state');
    strip.innerHTML = `<span>${icon('clock')}</span><span>${esc(sendFailureLine(e))}</span>`;
    const retry = el('button', 'sm', 'Try again');
    retry.onclick = () => {
      row.remove();
      store.seen.delete('n:' + nonce);
      c.value = text;
      autogrow();
      send();
    };
    strip.appendChild(retry);
    const anchor = mbody.querySelector('.rxns');
    if (anchor) mbody.insertBefore(strip, anchor); else mbody.appendChild(strip);
    scrollDown();
    // No red toast on top of it. The row is on screen and says what happened;
    // an alarm about something already explained in place reads as two failures.
    if (!row.isConnected) toast(sendFailureLine(e));
  }
}

// A person who cannot send does not need an error code, they need to know
// whether to try again now or later. Everything else is noise.
function sendFailureLine(e) {
  const msg = String(e?.message || '');
  if (!navigator.onLine || /No connection|Failed to fetch|NetworkError/i.test(msg)) {
    return 'Not sent - no internet. Try again when you are back.';
  }
  if (/rate_limited|53400|too fast/i.test(msg)) return 'Not sent - slow down a moment, then try again.';
  return 'Not sent. ' + (msg || 'Try again.');
}

// ------------------------------------------------------------------ reply bar
export function setReply(m) {
  store.replyTarget = { id: m.id, author_id: m.author_id, body_text: m.body_text };
  const bar = $('replyBar');
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="reply-ico">↩</span>
    <span>Replying to <b>${esc(nameOf(m.author_id))}</b></span>
    <span class="muted reply-snip">${esc((m.body_text || '').slice(0, 70))}</span>
    <button class="icon" id="cancelReply">✕</button>`;
  $('cancelReply').onclick = clearReply;
  composerEl().focus();
}

export function clearReply() {
  store.replyTarget = null;
  const b = $('replyBar');
  b.classList.add('hidden');
  b.innerHTML = '';
}

function autogrow() {
  const c = composerEl();
  if (!c) return;
  c.style.height = 'auto';
  c.style.height = Math.min(220, c.scrollHeight) + 'px';
}

// ------------------------------------------------------------------ wiring
export function initComposer() {
  const c = composerEl();
  if (!c) return;
  setComposerEnabled(false);
  bus.on('channel:open', () => { resetTyping(); setComposerEnabled(true); });
  bus.on('dm:open', () => { resetTyping(); setComposerEnabled(true); });

  c.addEventListener('keydown', (e) => {
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; paintAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; paintAc(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); ac.onPick(ac.items[ac.index]); return; }
      if (e.key === 'Escape') { acHide(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape' && store.replyTarget) { clearReply(); return; }
    if (e.key === 'ArrowUp' && !c.value) {
      // Slack muscle memory: up-arrow on an empty composer edits your last message.
      const mine = [...document.querySelectorAll('.msg.me')].pop();
      if (mine?.dataset.id) { e.preventDefault(); bus.emit('message:editLast', { id: mine.dataset.id }); }
    }
  });

  c.addEventListener('input', () => { autogrow(); updateAutocomplete(); emitTyping(); saveDraft(); });
  c.addEventListener('blur', () => { setTimeout(acHide, 120); stopTyping(); });
  // A tab going away mid-sentence would otherwise leave "Asha is typing…" on
  // everyone else's screen until it expired, which is the state that makes a
  // typing indicator feel like a lie.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopTyping();
  });
  c.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  $('emojiBtn').onclick = () => openEmojiPicker($('emojiBtn'), (ch) => {
    const cc = composerEl();
    const pos = cc.selectionStart;
    cc.value = cc.value.slice(0, pos) + ch + ' ' + cc.value.slice(pos);
    cc.focus();
    cc.setSelectionRange(pos + ch.length + 1, pos + ch.length + 1);
    autogrow();
  });
  $('sendBtn').onclick = () => send();

  // drag and drop anywhere
  let dragCount = 0;
  const hint = $('dropHint');
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragCount++; hint.classList.remove('hidden'); }
  });
  window.addEventListener('dragleave', () => { if (--dragCount <= 0) { dragCount = 0; hint.classList.add('hidden'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCount = 0;
    hint.classList.add('hidden');
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  renderComposerButtons();
}

export const composerText = () => composerEl().value;
export function setComposerText(t) { composerEl().value = t; autogrow(); composerEl().focus(); }
