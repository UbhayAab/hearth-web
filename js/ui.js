// The UI kit and the extension registry. Feature modules never touch the shell
// markup directly - they register through here, so features can be added in
// parallel without colliding.
import { $, el, esc } from './util.js';
import { bus } from './store.js';

// ------------------------------------------------------------------ toasts
let toastHost;
export function toast(msg, kind = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = el('div', 'toasts');
    document.body.appendChild(toastHost);
  }
  const t = el('div', 'toast toast-' + kind, esc(msg));
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
  return t;
}

// ------------------------------------------------------------------ modals
// modal({title, body, actions:[{label,kind,onClick(close)}], wide}) -> {root, body, close}
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const back = el('div', 'modal-back');
  const box = el('div', 'modal' + (wide ? ' modal-wide' : ''));
  const head = el('div', 'modal-head', `<strong>${esc(title || '')}</strong>`);
  const x = el('button', 'icon', '✕');
  head.appendChild(x);
  const bodyEl = el('div', 'modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = el('div', 'modal-foot');
  box.append(head, bodyEl, foot);
  back.appendChild(box);

  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  x.onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };

  for (const a of actions) {
    const b = el('button', a.kind === 'ghost' ? 'ghost' : a.kind === 'danger' ? 'danger' : '', esc(a.label));
    b.onclick = () => a.onClick?.(close, bodyEl);
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();

  document.body.appendChild(back);
  setTimeout(() => box.querySelector('input,textarea,select,button')?.focus(), 30);
  return { root: back, box, body: bodyEl, foot, close };
}

export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<p>${esc(body || '')}</p>`,
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: (c) => { done = true; c(); resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : '', onClick: (c) => { done = true; c(); resolve(true); } },
      ],
    });
    m.box.querySelector('.modal-foot button:last-child')?.focus();
  });
}

// A real replacement for window.prompt: fields = [{name,label,type,value,placeholder,options,rows,required}]
export function formModal({ title, fields = [], submitLabel = 'Save', wide = false, note }) {
  return new Promise((resolve) => {
    let done = false;
    const form = el('form', 'form');
    for (const f of fields) {
      const wrap = el('label', 'field');
      wrap.appendChild(el('span', 'field-label', esc(f.label || f.name)));
      let input;
      if (f.type === 'textarea') {
        input = el('textarea');
        input.rows = f.rows || 4;
      } else if (f.type === 'select') {
        input = el('select');
        for (const o of f.options || []) {
          const opt = el('option', null, esc(o.label ?? o));
          opt.value = o.value ?? o;
          input.appendChild(opt);
        }
      } else if (f.type === 'checkbox') {
        input = el('input');
        input.type = 'checkbox';
        input.checked = !!f.value;
        wrap.classList.add('field-check');
      } else {
        input = el('input');
        input.type = f.type || 'text';
      }
      if (f.type !== 'checkbox' && f.value != null) input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.required) input.required = true;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      input.name = f.name;
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el('span', 'field-hint', esc(f.hint)));
      form.appendChild(wrap);
    }
    if (note) form.appendChild(el('p', 'muted', esc(note)));

    const m = modal({
      title, body: form, wide,
      onClose: () => { if (!done) resolve(null); },
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: (c) => { done = true; c(); resolve(null); } },
        {
          label: submitLabel,
          onClick: (c) => {
            const out = {};
            for (const f of fields) {
              const i = form.elements[f.name];
              out[f.name] = f.type === 'checkbox' ? i.checked : i.value;
            }
            const missing = fields.find((f) => f.required && !String(out[f.name] || '').trim());
            if (missing) { toast(`${missing.label || missing.name} is required`, 'error'); return; }
            done = true; c(); resolve(out);
          },
        },
      ],
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      m.foot.querySelector('button:last-child').click();
    };
  });
}

// ------------------------------------------------------------------ side panel
const panels = new Map();
let activePanel = null;

// registerPanel({id, title, icon, render(bodyEl, ctx), footer(footEl), onClose})
export function registerPanel(def) { panels.set(def.id, def); }

export async function openPanel(id, ctx = {}) {
  const def = panels.get(id);
  if (!def) return console.warn('no panel', id);
  activePanel = id;
  const aside = $('panel');
  aside.classList.remove('hidden');
  document.body.classList.add('panel-open');
  $('panelTitle').textContent = typeof def.title === 'function' ? def.title(ctx) : def.title;
  const body = $('panelContent');
  body.innerHTML = '<div class="muted pad">loading…</div>';
  const foot = $('panelFooter');
  foot.innerHTML = '';
  foot.classList.add('hidden');
  try {
    await def.render(body, ctx);
    if (def.footer) { foot.classList.remove('hidden'); await def.footer(foot, ctx); }
  } catch (e) {
    body.innerHTML = `<div class="muted pad">${esc(e.message || 'failed to load')}</div>`;
  }
}

export function closePanel() {
  const id = activePanel;
  activePanel = null;
  $('panel').classList.add('hidden');
  document.body.classList.remove('panel-open');
  $('panelContent').innerHTML = '';
  $('panelFooter').innerHTML = '';
  $('panelFooter').classList.add('hidden');
  if (id) panels.get(id)?.onClose?.();
  bus.emit('panel:close', { id });
}

export const currentPanel = () => activePanel;
export const refreshPanel = (ctx) => (activePanel ? openPanel(activePanel, ctx || {}) : null);

// ------------------------------------------------------------------ header buttons
const headerButtons = [];
export function addHeaderButton(def) {
  headerButtons.push({ order: 50, ...def });
  renderHeaderButtons();
}
// Visible, in registration order, after the show() filter. The shell decides how
// many of these fit on the channel bar and puts the rest behind one overflow
// menu - a feature never has to know which side of that line it landed on.
export function getHeaderButtons() {
  return [...headerButtons].sort((a, z) => a.order - z.order)
    .filter((b) => !b.show || b.show());
}

// Only the first `inlineCap` render as buttons. Thirteen identical glyphs in a
// row is a wall, not a toolbar.
export let inlineCap = 4;
export function setInlineCap(n) { inlineCap = n; renderHeaderButtons(); }

export function renderHeaderButtons() {
  const host = $('headerActions');
  if (!host) return;
  host.innerHTML = '';
  for (const b of getHeaderButtons().slice(0, inlineCap)) {
    const n = el('button', 'icon' + (b.cls ? ' ' + b.cls : ''), b.label);
    n.title = b.title || '';
    // Icon-only buttons contain an SVG with no text, so without this a screen
    // reader announces nothing at all.
    n.setAttribute('aria-label', b.title || b.id);
    n.id = 'hb-' + b.id;
    n.onclick = (e) => b.onClick(e);
    host.appendChild(n);
  }
}

// ------------------------------------------------------------------ nav sections
const navSections = [];
// addNavSection({id, order, render(hostEl)}) - rendered under the channel list
export function addNavSection(def) { navSections.push({ order: 50, ...def }); }
export async function renderNavSections() {
  const host = $('navExtra');
  if (!host) return;
  host.innerHTML = '';
  for (const s of [...navSections].sort((a, z) => a.order - z.order)) {
    if (s.show && !s.show()) continue;
    const wrap = el('div', 'navsec');
    host.appendChild(wrap);
    try { await s.render(wrap); } catch (e) { console.warn('navsec', s.id, e); }
  }
}

// ------------------------------------------------------------------ message actions
const messageActions = [];
// addMessageAction({id, label, title, order, show(msg), onClick(msg, ev, el)})
export function addMessageAction(def) { messageActions.push({ order: 50, ...def }); }
export const getMessageActions = (msg) =>
  [...messageActions].sort((a, z) => a.order - z.order).filter((a) => !a.show || a.show(msg));

// ------------------------------------------------------------------ composer buttons
const composerButtons = [];
export function addComposerButton(def) { composerButtons.push({ order: 50, ...def }); }
export function renderComposerButtons() {
  const host = $('composerTools');
  if (!host) return;
  host.innerHTML = '';
  for (const b of [...composerButtons].sort((a, z) => a.order - z.order)) {
    if (b.show && !b.show()) continue;
    const n = el('button', 'icon', b.label);
    n.title = b.title || '';
    n.type = 'button';
    n.onclick = (e) => b.onClick(e);
    host.appendChild(n);
  }
}

// ------------------------------------------------------------------ slash commands
const slashCommands = new Map();
// addSlashCommand({name, description, args, run(argText)})
export function addSlashCommand(def) { slashCommands.set(def.name.replace(/^\//, ''), def); }
export const listSlash = () => [...slashCommands.values()];
export function findSlash(name) { return slashCommands.get((name || '').replace(/^\//, '')); }

// Returns true if the text was handled as a slash command.
export async function runSlash(text) {
  const m = (text || '').match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return false;
  const cmd = slashCommands.get(m[1].toLowerCase());
  if (!cmd) return false;
  try { await cmd.run(m[2].trim()); } catch (e) { toast(e.message || 'command failed', 'error'); }
  return true;
}

// ------------------------------------------------------------------ quick switcher sources
const switcherSources = [];
// addSwitcherSource({id, search(q) -> [{label, hint, icon, run()}]})
export function addSwitcherSource(def) { switcherSources.push(def); }
export const getSwitcherSources = () => switcherSources;

// ------------------------------------------------------------------ context menu
export function contextMenu(ev, items) {
  document.querySelector('.ctxmenu')?.remove();
  const menu = el('div', 'ctxmenu');
  for (const it of items) {
    if (it === '-') { menu.appendChild(el('div', 'ctx-sep')); continue; }
    if (it.show === false) continue;
    const b = el('div', 'ctx-item' + (it.danger ? ' danger' : ''), esc(it.label));
    b.onclick = () => { menu.remove(); it.onClick?.(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const x = Math.min(ev.clientX, window.innerWidth - r.width - 8);
  const y = Math.min(ev.clientY, window.innerHeight - r.height - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  const away = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', away); }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
  return menu;
}

// ------------------------------------------------------------------ popover
export function popover(anchorEl, contentEl, opts = {}) {
  document.querySelector('.popover')?.remove();
  const p = el('div', 'popover' + (opts.cls ? ' ' + opts.cls : ''));
  p.appendChild(contentEl);
  document.body.appendChild(p);
  const a = anchorEl.getBoundingClientRect();
  const r = p.getBoundingClientRect();
  let top = opts.below ? a.bottom + 6 : a.top - r.height - 6;
  if (top < 8) top = a.bottom + 6;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
  let left = Math.min(a.left, window.innerWidth - r.width - 8);
  p.style.top = top + 'px';
  p.style.left = Math.max(8, left) + 'px';
  const away = (e) => {
    if (!p.contains(e.target) && !anchorEl.contains(e.target)) {
      p.remove();
      document.removeEventListener('mousedown', away);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
  return { el: p, close: () => p.remove() };
}

export function closePopovers() {
  document.querySelector('.popover')?.remove();
  document.querySelector('.ctxmenu')?.remove();
}

// ------------------------------------------------------------------ misc
export function spinner(text = 'loading…') { return el('div', 'muted pad', esc(text)); }
export function emptyState(text) { return el('div', 'empty', esc(text)); }

export const ui = {
  toast, modal, confirmModal, formModal, getHeaderButtons, setInlineCap,
  registerPanel, openPanel, closePanel, refreshPanel, currentPanel,
  addHeaderButton, renderHeaderButtons, addNavSection, renderNavSections,
  addMessageAction, getMessageActions, addComposerButton, renderComposerButtons,
  addSlashCommand, listSlash, findSlash, runSlash,
  addSwitcherSource, getSwitcherSources,
  contextMenu, popover, closePopovers, spinner, emptyState,
};

export default ui;
