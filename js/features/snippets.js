// Code snippets: write once, keep it, drop it into any conversation.
//
// The posted message carries the code itself in a fenced block, not just a link.
// get_snippet is owner-scoped on the server, so a bare link would open for the
// author and 404 for everyone else - the fence is what makes it readable by the
// channel, and the link is the author's way back to the original.
import { tryRpc } from '../api.js';
import { store, bus } from '../store.js';
import { $, el, esc, relTime } from '../util.js';
import { icon } from '../icons.js';

const PANEL = 'snippets';

const LANGUAGES = [
  'text', 'javascript', 'typescript', 'python', 'sql', 'bash', 'json', 'yaml',
  'html', 'css', 'java', 'go', 'rust', 'c', 'cpp', 'csharp', 'php', 'ruby',
  'kotlin', 'swift', 'markdown', 'diff',
];

let UI = null;
let API = null;

function style() {
  if (document.getElementById('snippets-css')) return;
  const s = el('style');
  s.id = 'snippets-css';
  s.textContent = `
    .snip-pre{margin:6px 0 0;padding:8px 10px;background:var(--panel2);
      border:1px solid var(--line);border-radius:8px;max-height:150px;overflow:auto;
      font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;
      line-height:1.45;white-space:pre;color:var(--text)}
    .snip-pre.snip-full{max-height:52vh}
    .snip-head{display:flex;align-items:center;gap:8px;font-size:12px}
    .snip-lang{background:var(--panel3);color:var(--dim);border-radius:9px;
      padding:1px 7px;font-size:11px}
    .snip-bar{gap:6px;flex-wrap:wrap;margin-top:8px}
    .snip-bar button{font-size:12px}
    .snip-open{margin-left:6px;font-size:12px}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ helpers
async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard api');
    await navigator.clipboard.writeText(text);
    UI.toast('Copied to clipboard', 'success');
    return;
  } catch { /* blocked or unavailable - fall through */ }
  const ta = el('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); UI.toast('Copied to clipboard', 'success'); }
  catch { UI.toast('Could not reach the clipboard', 'error'); }
  ta.remove();
}

// Insert at the caret and let the composer's own input handler autogrow and
// save the draft, rather than reaching into core for a setter.
function insertIntoComposer(text) {
  const c = $('composer');
  if (!c) { UI.toast('Open a channel first', 'error'); return; }
  const pos = c.selectionStart ?? c.value.length;
  const before = c.value.slice(0, pos);
  const ins = (before && !before.endsWith('\n') ? '\n' : '') + text + '\n';
  c.value = before + ins + c.value.slice(pos);
  c.focus();
  const end = pos + ins.length;
  c.setSelectionRange(end, end);
  c.dispatchEvent(new Event('input', { bubbles: true }));
  UI.toast('Added to the composer');
}

// A fence must be longer than any run of backticks inside the code, or the
// snippet closes itself halfway through.
function fenceFor(code) {
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  return fence;
}

function snippetBlock(s) {
  const code = s.code || '';
  const shown = code.length > 1400 ? code.slice(0, 1400) + '\n… (truncated)' : code;
  const fence = fenceFor(shown);
  const lang = s.language && s.language !== 'text' ? s.language : '';
  return `${fence}${lang}\n${shown}\n${fence}`;
}

function snippetMessage(s) {
  return `📎 **${s.title}** · snippet\n\n${snippetBlock(s)}\n\n[Open snippet](#/snippet/${s.id})`;
}

// ------------------------------------------------------------------ create
async function snippetDialog(prefillTitle = '') {
  if (!store.ws) { UI.toast('Join a Space first', 'error'); return null; }
  const out = await UI.formModal({
    title: 'New snippet',
    wide: true,
    fields: [
      { name: 'title', label: 'Title', required: true, value: prefillTitle,
        placeholder: 'Soop wrapper' },
      { name: 'language', label: 'Language', type: 'select',
        options: LANGUAGES.map((l) => ({ value: l, label: l })) },
      { name: 'code', label: 'Code', type: 'textarea', rows: 12, required: true,
        placeholder: 'paste it here' },
      { name: 'post', label: 'Post it to this channel too', type: 'checkbox', value: true },
    ],
    submitLabel: 'Create snippet',
    note: 'Snippets are yours. Posting one shares the code in the channel as a code block.',
  });
  if (!out) return null;

  let s;
  try {
    s = await API.createSnippet(store.ws.id, out.title.trim(), out.language, out.code);
  } catch (e) { UI.toast(e.message, 'error'); return null; }
  if (!s) { UI.toast('The server did not return the snippet', 'error'); return null; }

  UI.toast('Snippet saved', 'success');
  if (out.post) await postSnippet(s);
  if (UI.currentPanel() === PANEL) UI.refreshPanel();
  return s;
}

async function postSnippet(s) {
  const text = snippetMessage(s);
  try {
    if (store.currentDM) {
      await API.sendDM({ conversation: store.currentDM, nonce: crypto.randomUUID(), text });
    } else if (store.current) {
      await API.send({ channel: store.current.id, nonce: crypto.randomUUID(), text });
    } else {
      UI.toast('Open a channel to post it', 'error');
      return;
    }
  } catch (e) { UI.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ viewer
async function openSnippet(id) {
  const [s, err] = await tryRpc('get_snippet', { p_snippet: id });
  if (err || !s) {
    // Owner-scoped on the server: someone else's snippet is simply not readable.
    UI.modal({
      title: 'Snippet',
      body: `<div class="empty">This snippet is not available to you.<br>
        Snippets belong to the person who created them - the code in the message
        above is the shared copy.<br><span class="muted">${esc(err?.message || 'not found')}</span></div>`,
    });
    return;
  }
  const box = el('div');
  box.innerHTML = `<div class="snip-head"><b>${esc(s.title)}</b>
      <span class="snip-lang">${esc(s.language || 'text')}</span>
      <span class="muted">${esc(relTime(s.created_at))}</span></div>
    <pre class="snip-pre snip-full">${esc(s.code || '')}</pre>`;
  UI.modal({
    title: 'Snippet',
    body: box,
    wide: true,
    actions: [
      { label: 'Copy', kind: 'ghost', onClick: () => copyText(s.code || '') },
      { label: 'Insert into composer', kind: 'ghost', onClick: (close) => { close(); insertIntoComposer(snippetBlock(s)); } },
      { label: 'Post to channel', onClick: (close) => { close(); postSnippet(s); } },
    ],
  });
}

// ------------------------------------------------------------------ panel
function panel(ui) {
  ui.registerPanel({
    id: PANEL,
    title: 'Snippets',
    async render(body) {
      body.innerHTML = '<div class="muted pad">loading…</div>';
      const [rows, err] = await tryRpc('list_my_snippets', {});
      if (err) {
        body.innerHTML = `<div class="empty">Could not load your snippets.<br>${esc(err.message)}</div>`;
        return;
      }
      const list = Array.isArray(rows) ? rows : [];
      body.innerHTML = '';
      if (!list.length) {
        body.appendChild(el('div', 'empty',
          'No snippets yet. Run <b>/snippet</b> or use the <b>&lt;/&gt;</b> button by the '
          + 'composer to save a block of code once and paste it anywhere after that.'));
        return;
      }
      for (const s of list) body.appendChild(card(s));
    },
    footer(foot) {
      const b = el('button', 'wide', 'New snippet');
      b.onclick = () => snippetDialog();
      foot.appendChild(b);
    },
  });
}

function card(s) {
  const code = s.code || '';
  const preview = code.split('\n').slice(0, 8).join('\n');
  const box = el('div', 'result');
  box.innerHTML = `<div class="snip-head"><b>${esc(s.title)}</b>
      <span class="snip-lang">${esc(s.language || 'text')}</span>
      <span class="muted">${esc(relTime(s.created_at))}</span></div>
    <pre class="snip-pre">${esc(preview)}${code.split('\n').length > 8 ? '\n…' : ''}</pre>`;

  const bar = el('div', 'row gap snip-bar');
  const add = (label, title, fn) => {
    const b = el('button', 'sm ghost', label);
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    bar.appendChild(b);
  };
  add('Copy', 'Copy the code to the clipboard', () => copyText(code));
  add('Insert', 'Drop it into the composer as a code block', () => insertIntoComposer(snippetBlock(s)));
  add('Post', 'Send it to the open conversation', () => postSnippet(s));
  box.appendChild(bar);
  box.onclick = () => openSnippet(s.id);
  return box;
}

// ------------------------------------------------------------------ register
export function register({ ui, api }) {
  style();
  UI = ui;
  API = api;
  panel(ui);

  ui.addSlashCommand({
    name: 'snippet',
    description: 'Save a code snippet and share it',
    run: (arg) => snippetDialog(arg || ''),
  });

  ui.addComposerButton({
    id: 'snippet', label: icon('code'), title: 'Create a code snippet',
    onClick: () => snippetDialog(),
  });
  // The composer toolbar is painted during boot, before features finish loading.
  ui.renderComposerButtons();

  ui.addSwitcherSource({
    id: 'snippets',
    search: (q) => {
      const s = (q || '').toLowerCase();
      if (s && !'snippet'.startsWith(s) && !'code'.startsWith(s)) return [];
      return [
        { label: 'New snippet', hint: 'Save and share code', icon: '📎', run: () => snippetDialog() },
        { label: 'My snippets', hint: 'Everything you have saved', icon: '📎', run: () => ui.openPanel(PANEL, {}) },
      ];
    },
  });

  // A markdown link cannot navigate the app on its own - DOMPurify forces
  // target=_blank on every anchor - so rewire ours as we render each message.
  bus.on('message:render', ({ el: row }) => {
    row.querySelectorAll('a[href^="#/snippet/"]').forEach((a) => {
      a.removeAttribute('target');
      a.onclick = (e) => {
        e.preventDefault();
        openSnippet(a.getAttribute('href').split('/').pop());
      };
    });
  });

  // Someone pasting the link into the address bar should land somewhere too.
  window.addEventListener('hashchange', () => {
    const m = (location.hash || '').match(/^#\/snippet\/([0-9a-f-]{36})$/i);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    openSnippet(m[1]);
  });
}
