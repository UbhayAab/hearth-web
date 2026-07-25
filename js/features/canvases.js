// Canvases: the shared-document surface. A canvas is an ordered list of blocks
// (text, heading, checklist, code, divider) that every member who can see it may
// edit at the same time. Almost all of the work here is about editing without
// stepping on the other person: a block that has focus or an unsaved edit is
// never re-rendered from the server, and the poll only replaces blocks whose
// server signature actually changed.
// highlight.js is 458 KB over 195 requests. Importing it here put the whole of
// it on the app's first load, because features are registered at boot - for a
// code block inside a canvas that most people will never open. Fetched on the
// first code block instead, and the block is repainted when it lands.
let hljs = null;
let hljsPending = null;
function loadHljs() {
  if (!hljsPending) {
    hljsPending = import('https://esm.sh/highlight.js@11.10.0')
      .then((m) => { hljs = m.default || m; repaintCanvasCode(); return hljs; })
      .catch(() => null);
  }
  return hljsPending;
}
function repaintCanvasCode() {
  if (!hljs) return;
  for (const n of document.querySelectorAll('.cv-pre > code[data-cv-hl]')) {
    const lang = n.getAttribute('data-cv-hl');
    try {
      if (lang && hljs.getLanguage(lang)) n.innerHTML = hljs.highlight(n.textContent, { language: lang }).value;
    } catch { /* keep the escaped text */ }
    n.removeAttribute('data-cv-hl');
  }
}
import { nameOf } from '../store.js';
import { tryRpc } from '../api.js';
import { el, esc, fmt, relTime, debounce } from '../util.js';
import { icon } from '../icons.js';

let ui, api, store, bus;

// Titles for the quick switcher. Synchronous search needs a local list, so it is
// warmed in the background and refreshed whenever the panel loads.
let cache = [];

const POLL_MS = 4000;          // slow enough to be free, fast enough to feel live
const SAVE_DEBOUNCE_MS = 900;  // typing pause before a block write
const GAP = 1000;              // position gap so a later insert never needs a rewrite
const BASE_STATUS = 'Saves as you type · live for everyone with access while this is open';

const TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'heading', label: 'Heading' },
  { value: 'checklist', label: 'To-do' },
  { value: 'code', label: 'Code' },
  { value: 'divider', label: 'Divider' },
];

const textOf = (b) => (b && b.content && typeof b.content === 'object' ? b.content.text : '') || '';
const langOf = (b) => (b && b.content && typeof b.content === 'object' ? b.content.lang : '') || '';
const posOf = (b) => Number(b?.position ?? 0);

// updated_at moves on every server write, so it is enough to tell a block that
// changed under us from one that did not.
const sigOf = (b) => `${b.position}|${b.checked}|${b.updated_at}`;

// ------------------------------------------------------------------ styles
function injectStyles() {
  if (document.getElementById('cv-styles')) return;
  const s = el('style');
  s.id = 'cv-styles';
  s.textContent = `
.cv-new{width:100%;margin:0 0 10px}
.cv-row b{display:block;margin-bottom:2px}
.cv-modal .modal{max-width:min(900px,94vw)}
.cv-title{background:transparent;border:1px solid transparent;font-weight:700;font-size:16px;
  padding:4px 7px;width:100%}
.cv-title:hover{border-color:var(--line)}
.cv-title:focus{border-color:var(--accent);background:var(--panel2)}
.cv-blocks{display:flex;flex-direction:column;gap:1px}
.cv-block{display:flex;gap:6px;align-items:flex-start;border:1px solid transparent;
  border-radius:8px;padding:2px 4px 2px 6px}
.cv-block:hover{border-color:var(--line)}
.cv-main{flex:1;min-width:0}
.cv-view{padding:5px 6px;border-radius:6px;cursor:text;min-height:28px}
.cv-view:hover{background:var(--panel2)}
.cv-ph{color:var(--faint)}
.cv-edit{resize:none;overflow:hidden;min-height:34px;padding:5px 6px}
.cv-heading .cv-view,.cv-heading .cv-edit{font-size:19px;font-weight:700;line-height:1.4}
.cv-code .cv-edit{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
.cv-pre{background:#0d1017;border:1px solid var(--line);border-radius:8px;padding:10px 12px;
  margin:0;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
.cv-lang{width:120px;font-size:12px;padding:3px 8px;margin-bottom:5px}
.cv-check{width:auto;margin:11px 0 0;flex:none}
.cv-done .cv-view{text-decoration:line-through;color:var(--dim)}
.cv-hr{border:none;border-top:1px solid var(--line);margin:12px 0;width:100%}
.cv-tools{display:flex;opacity:0;flex:none}
.cv-block:hover .cv-tools,.cv-block:focus-within .cv-tools{opacity:1}
.cv-add{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);flex-wrap:wrap}
.cv-type{width:auto}
.cv-status{font-size:11.5px;margin-top:10px}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ editor
function openEditor(canvasId) {
  const host = el('div', 'cv-doc');
  const blocksEl = el('div', 'cv-blocks', '<div class="muted pad">loading…</div>');
  const addRow = el('div', 'row gap cv-add hidden');
  const status = el('div', 'muted cv-status');
  host.append(blocksEl, addRow, status);

  const titleInput = el('input', 'cv-title');
  titleInput.placeholder = 'Untitled canvas';

  let closed = false;
  let timer = null;
  let blocks = [];                 // last server order, used for move maths
  const nodes = new Map();         // block id -> live DOM node

  const m = ui.modal({
    title: 'Canvas',
    body: host,
    wide: true,
    onClose: () => { closed = true; clearTimeout(timer); },
  });
  m.root.classList.add('cv-modal');
  const head = m.box.querySelector('.modal-head strong');
  head.innerHTML = '';
  head.appendChild(titleInput);

  const anyEditing = () => [...nodes.values()].some((n) => n._cv.editing || n._cv.dirty);
  const setStatus = (t, bad) => {
    status.textContent = t;
    status.className = 'cv-status ' + (bad ? 'send-error' : 'muted');
  };

  // ---- title ----
  // The modal autofocuses its first input, which is this one, so "is it focused"
  // is not a safe test for "the user is renaming" - track real typing instead.
  let lastTitle = '';
  let titleDirty = false;
  const saveTitle = async () => {
    const v = titleInput.value.trim();
    titleDirty = false;
    if (!v || v === lastTitle) { titleInput.value = lastTitle; return; }
    try {
      const row = await api.updateCanvasTitle(canvasId, v);
      lastTitle = row?.title || v;
      titleInput.value = lastTitle;
      if (ui.currentPanel() === 'canvases') ui.refreshPanel();
    } catch (e) {
      titleInput.value = lastTitle;
      ui.toast(e.message, 'error');
    }
  };
  titleInput.addEventListener('input', () => { titleDirty = true; });
  titleInput.addEventListener('blur', saveTitle);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
    if (e.key === 'Escape') { titleInput.value = lastTitle; titleDirty = false; titleInput.blur(); }
  });

  // ---- one block ----
  function buildBlock(b) {
    const node = el('div', 'cv-block cv-' + esc(b.type));
    const st = {
      id: b.id, type: b.type, block: b, sig: sigOf(b),
      editing: false, dirty: false, chain: Promise.resolve(),
    };
    node._cv = st;

    // Writes for one block are serialised so a debounced save and a blur save
    // can never land out of order.
    const push = (fn) => {
      st.chain = st.chain.then(fn).catch((e) => ui.toast(e.message, 'error'));
      return st.chain;
    };

    const main = el('div', 'cv-main');
    const tools = el('div', 'cv-tools');

    if (b.type === 'divider') {
      main.appendChild(el('hr', 'cv-hr'));
    } else {
      const view = el('div', 'cv-view body');
      const edit = el('textarea', 'cv-edit hidden');
      const lang = b.type === 'code' ? el('input', 'cv-lang') : null;
      st.view = view;
      st.edit = edit;

      const paint = () => {
        const t = textOf(st.block);
        if (b.type === 'heading') view.innerHTML = t ? esc(t) : '<span class="cv-ph">Heading</span>';
        else if (b.type === 'code') view.innerHTML = t ? codeHtml(t, langOf(st.block)) : '<span class="cv-ph">Code block - click to write</span>';
        else if (b.type === 'checklist') view.innerHTML = t ? fmt(t) : '<span class="cv-ph">To-do item</span>';
        else view.innerHTML = t ? fmt(t) : '<span class="cv-ph">Empty - click to write</span>';
      };
      st.paint = paint;
      paint();

      const grow = () => { edit.style.height = 'auto'; edit.style.height = edit.scrollHeight + 'px'; };
      const commit = () => {
        const text = edit.value;
        if (text === textOf(st.block)) { st.dirty = false; return Promise.resolve(); }
        const content = b.type === 'code' ? { text, lang: (lang?.value || '').trim() } : { text };
        setStatus('Saving…');
        return push(async () => {
          const row = await api.updateBlock(st.id, content, null, null);
          if (row) { st.block = row; st.sig = sigOf(row); }
          st.dirty = false;
          setStatus('Saved · everyone here sees it');
        });
      };
      const debouncedCommit = debounce(() => { if (st.editing) commit(); }, SAVE_DEBOUNCE_MS);

      st.enter = () => {
        if (st.editing) { edit.focus(); return; }
        st.editing = true;
        edit.value = textOf(st.block);
        view.classList.add('hidden');
        edit.classList.remove('hidden');
        grow();
        edit.focus();
        const n = edit.value.length;
        edit.setSelectionRange(n, n);
      };
      view.onclick = st.enter;
      edit.oninput = () => { st.dirty = true; grow(); debouncedCommit(); };
      edit.onblur = async () => {
        st.editing = false;
        await commit();
        paint();
        edit.classList.add('hidden');
        view.classList.remove('hidden');
      };
      edit.onkeydown = (e) => { if (e.key === 'Escape') { edit.value = textOf(st.block); st.dirty = false; edit.blur(); } };

      if (lang) {
        lang.placeholder = 'language';
        lang.value = langOf(st.block);
        lang.onchange = () => push(async () => {
          const row = await api.updateBlock(st.id, { text: textOf(st.block), lang: lang.value.trim() }, null, null);
          if (row) { st.block = row; st.sig = sigOf(row); paint(); }
        });
        main.appendChild(lang);
      }
      main.append(view, edit);
    }

    if (b.type === 'checklist') {
      const box = el('input', 'cv-check');
      box.type = 'checkbox';
      box.checked = !!b.checked;
      node.classList.toggle('cv-done', !!b.checked);
      box.onchange = () => push(async () => {
        const row = await api.updateBlock(st.id, null, box.checked, null);
        if (row) { st.block = row; st.sig = sigOf(row); }
        node.classList.toggle('cv-done', box.checked);
      });
      node.appendChild(box);
    }

    const tool = (label, title, fn) => {
      const btn = el('button', 'icon sm', label);
      btn.title = title;
      btn.onclick = fn;
      tools.appendChild(btn);
    };
    tool('↑', 'Move up', () => move(st.id, -1));
    tool('↓', 'Move down', () => move(st.id, 1));
    tool('✕', 'Delete block', () => removeBlock(st.id));

    node.append(main, tools);
    return node;
  }

  // ---- ordering ----
  // One write instead of a two-row swap: drop the block into the gap between its
  // new neighbours. The 1000-wide gaps mean that gap almost always exists.
  async function move(id, dir) {
    const i = blocks.findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= blocks.length) return;
    const near = blocks[j];
    const far = blocks[j + dir];
    let next = far ? (posOf(near) + posOf(far)) / 2 : posOf(near) + dir * GAP;
    if (next === posOf(near)) next = posOf(near) + dir * 0.001; // equal positions: nudge past
    try {
      await api.updateBlock(id, null, null, next);
      await refresh(true);
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  async function removeBlock(id) {
    const ok = await ui.confirmModal({
      title: 'Delete block', body: 'It disappears for everyone on this canvas.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteBlock(id);
      nodes.get(id)?.remove();
      nodes.delete(id);
      await refresh(true);
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  // ---- add row ----
  const typeSel = el('select', 'cv-type');
  for (const t of TYPES) {
    const o = el('option', null, esc(t.label));
    o.value = t.value;
    typeSel.appendChild(o);
  }
  const addBtn = el('button', 'sm', 'Add block');
  addBtn.onclick = async () => {
    const type = typeSel.value;
    const last = blocks.length ? posOf(blocks[blocks.length - 1]) : 0;
    addBtn.disabled = true;
    try {
      const row = await api.addBlock(canvasId, type, type === 'divider' ? {} : { text: '' }, last + GAP);
      await refresh(true);
      nodes.get(row?.id)?._cv?.enter?.();
    } catch (e) { ui.toast(e.message, 'error'); }
    finally { addBtn.disabled = false; }
  };
  addRow.append(typeSel, addBtn, el('span', 'muted', 'Blocks save as you type.'));

  // ---- render + poll ----
  function apply(doc) {
    const canvas = doc?.canvas || {};
    blocks = doc?.blocks || [];
    addRow.classList.remove('hidden');

    if (!titleDirty) {
      lastTitle = canvas.title || '';
      titleInput.value = lastTitle;
    }

    if (!blocks.length) {
      for (const [, n] of nodes) n.remove();
      nodes.clear();
      blocksEl.innerHTML = '<div class="empty">This canvas is empty. Add a heading, a paragraph or a to-do below and everyone who can see this canvas sees it too.</div>';
      return;
    }
    if (blocksEl.querySelector('.empty, .pad')) blocksEl.innerHTML = '';

    for (const b of blocks) {
      const existing = nodes.get(b.id);
      const st = existing?._cv;
      if (existing && (st.editing || st.dirty)) {
        // Somebody else changed it while this person is typing. Their blur wins;
        // keep the live DOM and only remember the newest server row.
        st.block = { ...b, content: st.block.content };
        continue;
      }
      if (existing && st.sig === sigOf(b) && st.type === b.type) { st.block = b; continue; }
      if (existing) existing.remove();
      const node = buildBlock(b);
      nodes.set(b.id, node);
    }
    for (const [id, node] of [...nodes]) {
      if (!blocks.some((b) => b.id === id)) { node.remove(); nodes.delete(id); }
    }
    // Re-parenting a node blurs whatever is inside it, so never reorder mid-edit.
    if (!anyEditing()) {
      blocks.forEach((b, i) => {
        const want = nodes.get(b.id);
        if (blocksEl.children[i] !== want) blocksEl.insertBefore(want, blocksEl.children[i] || null);
      });
    } else {
      for (const b of blocks) if (!nodes.get(b.id).isConnected) blocksEl.appendChild(nodes.get(b.id));
    }
  }

  let stalled = false;
  async function refresh(quiet) {
    if (closed) return;
    const [doc, err] = await tryRpc('get_canvas', { p_canvas: canvasId });
    if (closed) return;
    if (err) {
      // A failed poll is not worth a toast every four seconds - say it once, in place.
      if (!nodes.size && !blocks.length) blocksEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      stalled = true;
      setStatus('Live sync paused: ' + err.message, true);
      return;
    }
    apply(doc);
    if (!quiet || stalled) { stalled = false; setStatus(BASE_STATUS); }
  }

  async function loop() {
    await refresh(true);
    if (!closed) timer = setTimeout(loop, POLL_MS);
  }

  (async () => {
    await refresh(false);
    if (!closed) timer = setTimeout(loop, POLL_MS);
  })();

  return m;
}

// hljs escapes its own output, so this never needs esc() on top - but an unknown
// language falls back to plain escaped text rather than trusting anything.
function codeHtml(text, lang) {
  let inner;
  try {
    inner = hljs && lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : esc(text);
  } catch { inner = esc(text); }
  if (!hljs && lang) loadHljs();
  const pending = !hljs && lang ? ` data-cv-hl="${esc(lang)}"` : '';
  return `<pre class="cv-pre"><code${pending}>${inner}</code></pre>`;
}

// ------------------------------------------------------------------ create
async function createFlow(preTitle) {
  if (!store.ws) { ui.toast('Open a Space first', 'error'); return null; }
  const ch = store.current;
  const out = await ui.formModal({
    title: 'New canvas',
    fields: [
      { name: 'title', label: 'Title', value: preTitle || '', placeholder: 'Sprint plan', required: true },
      {
        name: 'where', label: 'Who can see it', type: 'select',
        options: [
          { value: 'space', label: 'Everyone in this Space' },
          ...(ch ? [{ value: 'channel', label: `#${ch.name} only` }] : []),
        ],
      },
    ],
    submitLabel: 'Create',
    note: 'A canvas is a shared document. Anyone who can see it can edit it.',
  });
  if (!out) return null;
  try {
    const cv = await api.createCanvas(store.ws.id, out.title.trim(), out.where === 'channel' && ch ? ch.id : null);
    cache = [cv, ...cache.filter((c) => c.id !== cv.id)];
    if (ui.currentPanel() === 'canvases') ui.refreshPanel();
    openEditor(cv.id);
    return cv;
  } catch (e) { ui.toast(e.message, 'error'); return null; }
}

async function warmCache() {
  if (!store?.ws) return;
  const [rows] = await tryRpc('list_canvases', { p_workspace: store.ws.id });
  if (rows) cache = rows;
}

// ------------------------------------------------------------------ register
export function register(app) {
  ({ ui, api, store, bus } = app);
  injectStyles();

  ui.registerPanel({
    id: 'canvases',
    title: 'Canvases',
    async render(body) {
      body.innerHTML = '<div class="muted pad">loading…</div>';
      if (!store.ws) {
        body.innerHTML = '<div class="empty">Open a Space to see its canvases.</div>';
        return;
      }
      const [rows, err] = await tryRpc('list_canvases', { p_workspace: store.ws.id });
      if (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
        return;
      }
      cache = rows || [];
      body.innerHTML = '';
      const nb = el('button', 'cv-new', '＋ New canvas');
      nb.onclick = () => createFlow('');
      body.appendChild(nb);

      if (!cache.length) {
        body.appendChild(el('div', 'empty',
          'No canvases here yet. A canvas is a shared document - meeting notes, a spec, a checklist - that everyone in this Space can edit at once. Create one above, or type /canvas &lt;title&gt; in a channel.'));
        return;
      }

      // Freshest work first: list_canvases orders by creation, which is not what
      // you want when the useful doc is the one somebody just touched.
      const sorted = [...cache].sort((a, z) =>
        new Date(z.updated_at || z.created_at) - new Date(a.updated_at || a.created_at));
      for (const c of sorted) {
        const ch = store.channels.find((x) => x.id === c.channel_id);
        const where = c.channel_id ? `#${esc(ch?.name || 'private channel')}` : 'whole Space';
        const row = el('div', 'result cv-row',
          `<b>${esc(c.title || 'Untitled')}</b>
           <div class="muted">${where} · updated ${esc(relTime(c.updated_at || c.created_at))} · started by ${esc(nameOf(c.created_by))}</div>`);
        row.onclick = () => openEditor(c.id);
        body.appendChild(row);
      }
    },
  });

  ui.addHeaderButton({
    id: 'canvases', label: icon('doc'), title: 'Canvases', order: 75,
    onClick: () => ui.openPanel('canvases'),
  });

  ui.addSlashCommand({
    name: 'canvas',
    description: 'Create a canvas in this channel: /canvas <title>',
    run: async (argText) => {
      const title = (argText || '').trim();
      if (!store.ws) { ui.toast('Open a Space first', 'error'); return; }
      if (!title) { await createFlow(''); return; }
      try {
        const cv = await api.createCanvas(store.ws.id, title, store.current?.id || null);
        cache = [cv, ...cache.filter((c) => c.id !== cv.id)];
        if (ui.currentPanel() === 'canvases') ui.refreshPanel();
        openEditor(cv.id);
      } catch (e) { ui.toast(e.message, 'error'); }
    },
  });

  ui.addSwitcherSource({
    id: 'canvases',
    search: (q) => cache
      .filter((c) => !q || (c.title || '').toLowerCase().includes(q.toLowerCase()))
      .slice(0, 6)
      .map((c) => ({ label: c.title || 'Untitled', hint: 'Canvas', icon: icon('doc'), run: () => openEditor(c.id) })),
  });

  bus.on('workspace', () => { cache = []; warmCache(); });
  warmCache();
}
