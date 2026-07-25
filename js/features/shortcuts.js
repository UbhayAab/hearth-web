// The power-user layer: keyboard navigation, a discoverable help sheet, the
// drafts inbox and a jump-to-unread nudge.
//
// Everything here is additive. Core already owns Ctrl/Cmd+K, Ctrl/Cmd+F, Escape,
// "/" and the composer's up-arrow-to-edit, so this module documents those rather
// than rebinding them, and only intercepts a chord when core would otherwise
// swallow it (Ctrl+Shift+K, where core's Ctrl+K check ignores the shift key).
import { store, bus, nameOf } from '../store.js';
import { table } from '../api.js';
import { el, esc, fmt, plain, relTime, debounce } from '../util.js';
import { icon } from '../icons.js';

const MOD = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') ? '⌘' : 'Ctrl';

// Events from a text field belong to the text field. Every binding below is
// gated on this, which is why "?" can be a bare key.
const isTyping = (e) => {
  const t = e.target || {};
  return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || !!t.isContentEditable;
};

const SHORTCUTS = [
  { section: 'Moving around', items: [
    { keys: [MOD, 'K'], what: 'Quick switcher: jump to a channel or a person' },
    { keys: ['Alt', '↑'], what: 'Previous channel' },
    { keys: ['Alt', '↓'], what: 'Next channel' },
    { keys: ['Alt', 'Shift', '↑'], what: 'Previous unread channel' },
    { keys: ['Alt', 'Shift', '↓'], what: 'Next unread channel' },
    { keys: [MOD, 'Shift', 'K'], what: 'New direct message' },
  ] },
  { section: 'Panels', items: [
    { keys: [MOD, 'F'], what: 'Search messages' },
    { keys: [MOD, 'Shift', 'A'], what: 'Activity' },
    { keys: [MOD, 'Shift', 'T'], what: 'Threads' },
    { keys: [MOD, '.'], what: 'Open or close the right panel' },
    { keys: ['Esc'], what: 'Close the panel and any popover' },
    { keys: ['?'], what: 'This help' },
  ] },
  { section: 'Writing', items: [
    { keys: ['/'], what: 'Focus the composer' },
    { keys: ['Enter'], what: 'Send' },
    { keys: ['Shift', 'Enter'], what: 'Newline instead of sending' },
    { keys: ['↑'], what: 'On an empty composer, edit your last message' },
  ] },
  { section: 'Reading and voice', items: [
    { keys: ['Shift', 'Esc'], what: 'Mark the current channel read' },
    { keys: ['Space'], what: 'Push to talk while push-to-talk is on in a voice room' },
  ] },
];

const STYLE = `
.sc-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 26px}
.sc-col h4{margin:12px 0 4px}
.sc-row{display:flex;align-items:baseline;gap:10px;padding:3px 0;font-size:13px}
.sc-row .sc-what{color:var(--dim);flex:1}
.sc-keys{display:flex;gap:3px;flex:none}
.sc-key{background:var(--panel3);border:1px solid var(--line);border-bottom-width:2px;
  border-radius:5px;padding:0 6px;font-size:11.5px;font-weight:700;line-height:18px;
  min-width:20px;text-align:center;white-space:nowrap}
.sc-cmd{font-size:12.5px}
.sc-cmd code{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.sc-jump{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:6;
  box-shadow:0 4px 16px #0008;display:flex;align-items:center;gap:7px}
.sc-draft-head{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:4px}
.sc-draft-head .sc-when{margin-left:auto;white-space:nowrap}
.sc-draft-row{display:flex;justify-content:flex-end;margin-top:4px}
@media (max-width:720px){.sc-grid{grid-template-columns:1fr}}
`;

function injectStyle() {
  if (document.getElementById('sc-style')) return;
  const s = el('style', null, STYLE);
  s.id = 'sc-style';
  document.head.appendChild(s);
}

const keysHtml = (keys) =>
  `<span class="sc-keys">${keys.map((k) => `<span class="sc-key">${esc(k)}</span>`).join('')}</span>`;

export function register(app) {
  const { ui, api } = app;
  injectStyle();

  // ---------------------------------------------------------------- help sheet
  function helpModal() {
    const box = el('div');
    const grid = el('div', 'sc-grid');
    // Two balanced columns rather than one long scroll: the whole point is that
    // the sheet is scannable in a single glance.
    const cols = [el('div', 'sc-col'), el('div', 'sc-col')];
    SHORTCUTS.forEach((group, i) => {
      const host = cols[i % 2];
      host.appendChild(el('h4', 'sec', esc(group.section)));
      for (const s of group.items) {
        host.appendChild(el('div', 'sc-row',
          `${keysHtml(s.keys)}<span class="sc-what">${esc(s.what)}</span>`));
      }
    });
    grid.append(cols[0], cols[1]);
    box.appendChild(grid);

    // Slash commands are read from the registry, so a command added by any other
    // feature module documents itself here for free.
    const cmds = [...ui.listSlash()].sort((a, z) => a.name.localeCompare(z.name));
    box.appendChild(el('h4', 'sec', 'Slash commands'));
    if (!cmds.length) {
      box.appendChild(el('div', 'empty', 'No slash commands are registered yet.'));
    } else {
      const cg = el('div', 'sc-grid');
      const ccols = [el('div', 'sc-col'), el('div', 'sc-col')];
      cmds.forEach((c, i) => {
        ccols[i % 2].appendChild(el('div', 'sc-row sc-cmd',
          `<code>/${esc(c.name)}</code><span class="sc-what">${esc(c.description || '')}</span>`));
      });
      cg.append(ccols[0], ccols[1]);
      box.appendChild(cg);
    }
    ui.modal({ title: 'Keyboard shortcuts', body: box, wide: true });
  }

  // ---------------------------------------------------------------- channel nav
  // Sidebar order is the truth here: "next channel" must mean the next one the
  // user can see, categories and collapsed groups included.
  function navChannelIds() {
    const dom = [...document.querySelectorAll('#channels [data-ch]')].map((n) => n.dataset.ch);
    if (dom.length) return dom;
    return store.channels.filter((c) => c.kind !== 'voice' && !c.archived_at).map((c) => c.id);
  }

  function step(dir, unreadOnly) {
    const ids = navChannelIds();
    if (!ids.length) return;
    const at = store.current ? ids.indexOf(store.current.id) : -1;
    // With nothing open, "next" starts at the top and "previous" wraps to the end.
    const from = at >= 0 ? at : (dir > 0 ? -1 : 0);
    for (let n = 1; n <= ids.length; n++) {
      const id = ids[(((from + dir * n) % ids.length) + ids.length) % ids.length];
      if (unreadOnly && !store.unread.get(id)?.unread) continue;
      if (id === store.current?.id) continue;
      bus.emit('channel:request', { channelId: id });
      return;
    }
    if (unreadOnly) ui.toast('Nothing unread', 'info');
  }

  // ---------------------------------------------------------------- right panel
  // ui.openPanel is not observable, so remember whatever closed last and reopen
  // that; Activity is the sane cold start.
  let lastPanel = 'activity';
  bus.on('panel:close', ({ id }) => { if (id) lastPanel = id; });
  // The shell's help button and the user menu both ask for this by name rather
  // than reaching into this module.
  bus.on('shortcuts:open', helpModal);
  bus.on('shortcuts:show', helpModal);

  function togglePanel() {
    const open = ui.currentPanel();
    if (open) { lastPanel = open; ui.closePanel(); } else ui.openPanel(lastPanel || 'activity');
  }

  // ---------------------------------------------------------------- key handler
  // Capture phase: core listens on window in the bubble phase and its Ctrl+K test
  // ignores shiftKey, so Ctrl+Shift+K has to be claimed before it gets there.
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || '').toLowerCase();

    if (!mod && !e.altKey && e.key === '?') { e.preventDefault(); helpModal(); return; }

    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey);
      return;
    }

    if (mod && e.shiftKey && k === 'k') {
      e.preventDefault();
      e.stopPropagation();   // otherwise core's Ctrl+K opens the quick switcher too
      bus.emit('dm:new');
      return;
    }
    if (mod && e.shiftKey && k === 'a') { e.preventDefault(); ui.openPanel('activity'); return; }
    if (mod && e.shiftKey && k === 't') { e.preventDefault(); ui.openPanel('threads-list'); return; }
    if (mod && !e.shiftKey && e.key === '.') { e.preventDefault(); togglePanel(); return; }

    if (e.key === 'Escape' && e.shiftKey) {
      if (!store.current) return;
      api.markRead('channel', store.current.id, store.current.last_seq || 0)
        .then(() => { ui.toast('Marked read'); bus.emit('unread:reload'); })
        .catch((err) => ui.toast(err.message, 'error'));
    }
  }, true);

  // ---------------------------------------------------------------- drafts
  let draftCount = 0;

  const scopeLabel = (d, threads) => {
    if (d.scope_type === 'channel') {
      const c = store.channels.find((x) => x.id === d.scope_id);
      return c ? { icon: '#', name: c.name, open: () => bus.emit('channel:request', { channelId: c.id }) } : null;
    }
    if (d.scope_type === 'dm') {
      const conv = store.dms.find((x) => x.conversation_id === d.scope_id);
      if (!conv) return null;
      const others = (conv.other_user_ids || []).filter((u) => u !== store.me);
      return { icon: '@', name: others.length ? others.map(nameOf).join(', ') : 'you',
        open: () => bus.emit('dm:request', { conversationId: d.scope_id }) };
    }
    if (d.scope_type === 'thread') {
      const t = threads.get(d.scope_id);
      if (!t) return null;
      const c = store.channels.find((x) => x.id === t.channel_id);
      return { icon: '💬', name: 'thread in #' + (c?.name || '?'),
        open: () => bus.emit('thread:openById', {
          threadId: t.id, channelId: t.channel_id, rootMessageId: t.root_message_id }) };
    }
    return null;
  };

  ui.registerPanel({
    id: 'drafts',
    title: 'Drafts',
    async render(body) {
      body.innerHTML = '<div class="muted pad">loading…</div>';
      let rows;
      try {
        rows = (await api.drafts()) || [];
      } catch (e) {
        body.innerHTML = `<div class="empty">${esc(e.message || 'could not load drafts')}</div>`;
        return;
      }
      rows = rows.filter((d) => (d.body_text || '').trim());
      draftCount = rows.length;
      ui.renderHeaderButtons();

      if (!rows.length) {
        body.innerHTML = '<div class="empty">No unsent drafts. Anything you type in a channel or a DM and leave without sending is saved here, on every device.</div>';
        return;
      }

      // Thread drafts only carry a thread id, so resolve them in one read.
      const threads = new Map();
      const tids = rows.filter((d) => d.scope_type === 'thread').map((d) => d.scope_id);
      if (tids.length) {
        for (const t of await table('threads', (q) => q.in('id', tids))) threads.set(t.id, t);
      }

      rows.sort((a, z) => new Date(z.updated_at || 0) - new Date(a.updated_at || 0));
      body.innerHTML = '';
      for (const d of rows) {
        const scope = scopeLabel(d, threads);
        const card = el('div', 'result');
        card.innerHTML = `
          <div class="sc-draft-head muted">
            <span class="ch-ico">${scope ? esc(scope.icon) : '📄'}</span>
            <b>${esc(scope ? scope.name : 'another Space')}</b>
            <span class="sc-when">${esc(relTime(d.updated_at || Date.now()))}</span>
          </div>
          <div class="body">${fmt(plain(d.body_text, 160))}</div>`;
        card.onclick = () => {
          if (!scope) { ui.toast('That draft belongs to another Space', 'info'); return; }
          // Seed the shared draft map first: openChannel/openDM read the composer
          // value straight out of it, synchronously.
          store.drafts.set(d.scope_type + ':' + d.scope_id, d.body_text);
          scope.open();
          const c = document.getElementById('composer');
          if (c) { c.value = d.body_text; c.focus(); }
        };
        const bar = el('div', 'sc-draft-row');
        const del = el('button', 'sm ghost', 'Delete');
        del.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            await api.deleteDraft(d.scope_type, d.scope_id);
            store.drafts.delete(d.scope_type + ':' + d.scope_id);
            ui.refreshPanel();
          } catch (err) { ui.toast(err.message, 'error'); }
        };
        bar.appendChild(del);
        card.appendChild(bar);
        body.appendChild(card);
      }
    },
  });

  ui.addHeaderButton({
    id: 'drafts',
    label: icon('edit') + '<span class="badge sc-dcount"></span>',
    title: 'Unsent drafts',
    order: 70,
    show: () => draftCount > 0,
    onClick: () => ui.openPanel('drafts'),
  });

  // The count lives inside the button label, which ui.js re-renders wholesale
  // whenever any feature adds a button. Watch the row instead of guessing when.
  function paintDraftBadge() {
    const b = document.querySelector('#hb-drafts .sc-dcount');
    if (b) b.textContent = draftCount;
  }
  const hdrHost = document.getElementById('headerActions');
  if (hdrHost) new MutationObserver(paintDraftBadge).observe(hdrHost, { childList: true });

  const refreshDrafts = debounce(async () => {
    if (!store.me) return;
    try {
      const rows = (await api.drafts()) || [];
      draftCount = rows.filter((d) => (d.body_text || '').trim()).length;
    } catch { draftCount = 0; }   // signed out or offline: just hide the affordance
    ui.renderHeaderButtons();
    paintDraftBadge();
  }, 400);

  bus.on('channel:open', refreshDrafts);
  bus.on('dm:open', refreshDrafts);
  bus.on('workspace', refreshDrafts);
  bus.on('auth', refreshDrafts);

  // ---------------------------------------------------------------- jump to unread
  function unreadChannels() {
    return navChannelIds()
      .filter((id) => id !== store.current?.id)
      .filter((id) => !!store.unread.get(id)?.unread);
  }

  function paintJump() {
    const host = document.querySelector('section.msgs');
    if (!host) return;
    let b = document.getElementById('scJumpUnread');
    if (!b) {
      b = el('button', 'sm sc-jump hidden');
      b.id = 'scJumpUnread';
      b.onclick = () => {
        const first = unreadChannels()[0];
        if (first) bus.emit('channel:request', { channelId: first });
      };
      host.appendChild(b);
    }
    const list = unreadChannels();
    if (!list.length) { b.classList.add('hidden'); return; }
    // Sidebar order is oldest-first by position, so the head of the list is the
    // one that has been waiting longest in the reading order the user sees.
    const c = store.channels.find((x) => x.id === list[0]);
    b.innerHTML = `↑ ${list.length} unread ${list.length === 1 ? 'channel' : 'channels'}` +
      (c ? ` <span class="muted">#${esc(c.name)}</span>` : '');
    b.classList.remove('hidden');
  }

  bus.on('unread', paintJump);
  bus.on('channels', paintJump);
  bus.on('channel:open', paintJump);
  bus.on('dm:open', paintJump);
  bus.on('workspace', paintJump);

  // ---------------------------------------------------------------- slash commands
  ui.addSlashCommand({
    name: 'shortcuts', description: 'Show every keyboard shortcut', run: () => helpModal(),
  });

  // Core heartbeats 'online' every 45s, which would stomp an away/dnd status
  // within the minute. Re-assert it from here until /back clears it.
  let presenceHold = null;
  function holdPresence(status) {
    clearInterval(presenceHold);
    if (status === 'online') { presenceHold = null; return; }
    presenceHold = setInterval(() => {
      api.setPresenceStatus(status).catch(() => {});
    }, 20000);
  }
  async function setPresence(status, msg) {
    try {
      await api.setPresenceStatus(status);
      holdPresence(status);
      ui.toast(msg, 'success');
    } catch (e) { ui.toast(e.message, 'error'); }
  }
  ui.addSlashCommand({ name: 'away', description: 'Set yourself away', run: () => setPresence('away', 'You are away') });
  ui.addSlashCommand({ name: 'dnd', description: 'Do not disturb', run: () => setPresence('dnd', 'Do not disturb is on') });
  ui.addSlashCommand({ name: 'back', description: 'You are back online', run: () => setPresence('online', 'Welcome back') });

  // /shrug and /me post through the composer so they get the same optimistic
  // render, draft clearing and failure retry as anything typed by hand.
  const postViaComposer = async (text) => {
    if (!store.current && !store.currentDM) { ui.toast('Open a channel first', 'error'); return; }
    const mod = await import('../core/composer.js');
    mod.setComposerText(text);
    await mod.send();
  };
  ui.addSlashCommand({
    name: 'shrug', description: 'Append ¯\\_(ツ)_/¯ and send',
    run: (arg) => postViaComposer(((arg || '').trim() + ' ¯\\_(ツ)_/¯').trim()),
  });
  ui.addSlashCommand({
    name: 'me', description: 'Send an action in italics',
    run: (arg) => {
      const t = (arg || '').trim();
      if (!t) { ui.toast('Usage: /me is making tea', 'info'); return; }
      return postViaComposer('_' + t + '_');
    },
  });

  ui.addHeaderButton({
    id: 'shortcuts', label: icon('keyboard'), title: 'Keyboard shortcuts (?)', order: 999, onClick: helpModal,
  });
}
