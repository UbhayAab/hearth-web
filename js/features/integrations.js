// Integrations: the "make it programmable" surface - incoming webhooks, bots,
// remote slash commands and custom emoji.
//
// Every section here mints or spends a credential, which is what shapes the UI.
// The server stores only sha256(token) for webhooks and bots, so there is no
// "reveal" endpoint to call and never will be. The panel therefore shows a secret
// exactly once, at creation, inside a modal that says so in plain words. Being
// blunt about it up front is cheaper than the support ticket that follows a user
// closing the dialog and expecting to find the token in a list.
//
// Sections degrade independently: a member without MANAGE_CHANNELS still gets a
// useful bots/commands/emoji view instead of an error, and a missing or denied
// RPC hides its section with a sentence rather than throwing.
import { PERM, SUPABASE_URL, PUBLISHABLE } from '../config.js';
import { hasPerm } from '../store.js';
import { el, esc, plain, relTime } from '../util.js';
import { uploadFile, mediaUrl } from '../core/media.js';
import { icon } from '../icons.js';

// The ingress the edge function at supabase/functions/webhook/index.ts serves.
// It takes POST {token, text, username} and needs no user JWT - the token IS the
// credential - so the curl we hand people carries no auth header.
const WEBHOOK_URL = SUPABASE_URL + '/functions/v1/webhook';
// Bots post through PostgREST instead: post_as_bot is granted to anon, so the
// publishable key (already public, it ships in config.js) plus the bot token is
// the whole request.
const BOT_RPC_URL = SUPABASE_URL + '/rest/v1/rpc/post_as_bot';

const EMOJI_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const HANDLER_TIMEOUT_MS = 10000;

let app = null;                       // set by register(); section renderers close over it
const mySlash = new Set();            // commands this module registered, so a re-sync can replace them

// A denied RPC and a missing RPC both mean "hide the affordance, say why".
const isDenied = (e) => /forbidden|permission|denied|not authorized|42501/i.test(e?.message || '');
const isMissing = (e) => /could not find the function|does not exist|schema cache|PGRST202/i.test(e?.message || '');

async function copy(text, label) {
  try {
    await navigator.clipboard?.writeText(text);
    app.ui.toast(label || 'Copied');
  } catch {
    app.ui.toast('Could not reach the clipboard - select the text instead', 'error');
  }
}

// ------------------------------------------------------------------ chrome
const STYLE_ID = 'intg-style';
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.intg-lead{margin:2px 4px 12px;font-size:12.5px;line-height:1.55}
.intg-warn{background:var(--mention);border:1px solid var(--amber);border-radius:8px;
  padding:9px 11px;font-size:12.5px;line-height:1.5;margin:0 0 10px}
.intg-code{background:var(--panel3);border:1px solid var(--line);border-radius:8px;
  padding:9px 10px;margin:5px 0 2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:var(--text)}
.intg-caplabel{font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--faint);margin-top:11px}
.intg-row{display:flex;align-items:center;gap:8px}
.intg-grow{flex:1;min-width:0}
.intg-title{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis}
.intg-mini{font-size:12px;color:var(--dim);margin:0 4px 8px;line-height:1.5}
.intg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;
  color:var(--dim);word-break:break-all}
.intg-emoji{display:flex;flex-wrap:wrap;gap:10px;padding:4px 2px}
.intg-emoji-cell{width:78px;text-align:center;font-size:11px;color:var(--dim);
  word-break:break-all;cursor:pointer}
.intg-emoji-cell img,.intg-emoji-ph{width:38px;height:38px;object-fit:contain;display:flex;
  align-items:center;justify-content:center;margin:0 auto 4px;border-radius:7px;background:var(--panel3)}
`;
  document.head.appendChild(s);
}

function codeBlock(label, text) {
  const wrap = el('div');
  const head = el('div', 'intg-row');
  head.appendChild(el('div', 'intg-caplabel intg-grow', esc(label)));
  const btn = el('button', 'sm ghost', 'Copy');
  btn.onclick = () => copy(text, label + ' copied');
  head.appendChild(btn);
  wrap.append(head, el('div', 'intg-code', esc(text)));
  return wrap;
}

// The one-and-only sighting of a freshly minted token.
function secretModal({ title, lead, token, blocks = [] }) {
  const box = el('div');
  box.appendChild(el('p', 'muted', esc(lead)));
  box.appendChild(el('div', 'intg-warn',
    'Copy this now. Hearth keeps only a hash of it, so this is the only time it can ever be shown. '
    + 'Lose it and the only fix is to revoke this one and make a new one.'));
  box.appendChild(codeBlock('Token', token));
  for (const b of blocks) box.appendChild(codeBlock(b.label, b.code));
  app.ui.modal({ title, body: box, wide: true, actions: [{ label: 'I have copied it', onClick: (c) => c() }] });
}

function sectionShell(host, title) {
  host.appendChild(el('h4', 'sec', esc(title)));
  const body = el('div');
  host.appendChild(body);
  body.innerHTML = '<div class="muted pad">loading…</div>';
  return body;
}

// ------------------------------------------------------------------ webhooks
async function renderWebhooks(host) {
  const { store, sb } = app;
  // The RLS policy on incoming_webhooks is MANAGE_CHANNELS, and a denied SELECT
  // returns zero rows rather than an error - so gate on the bit instead of
  // letting an empty list masquerade as "none created yet".
  if (!hasPerm(PERM.MANAGE_CHANNELS)) {
    host.innerHTML = '<div class="empty">Hidden: creating and listing incoming webhooks needs the '
      + 'Manage channels permission. Ask a workspace admin if you need a URL for a CI job or a monitor.</div>';
    return;
  }
  const { data, error } = await sb.from('incoming_webhooks').select('*')
    .eq('workspace_id', store.ws.id).order('created_at', { ascending: false });
  host.innerHTML = '';
  if (error) { host.appendChild(el('div', 'empty', esc(error.message))); return; }

  host.appendChild(el('div', 'intg-mini',
    'A webhook gives an outside system one URL and one token. Anything it POSTs shows up as a message '
    + 'in the channel you picked. Nothing else about the workspace is exposed.'));

  const bar = el('div', 'row gap');
  const add = el('button', 'sm', 'New webhook');
  add.onclick = () => newWebhook();
  bar.appendChild(add);
  host.appendChild(bar);

  const rows = data || [];
  if (!rows.length) {
    host.appendChild(el('div', 'empty',
      'No webhooks yet. Create one and this list fills with every URL handed out, what channel it posts into, '
      + 'and a revoke button for the day a token leaks.'));
    return;
  }
  for (const w of rows) {
    const ch = store.channels.find((c) => c.id === w.channel_id);
    const card = el('div', 'result');
    const row = el('div', 'intg-row');
    row.innerHTML = `<div class="intg-grow">
      <div class="intg-title">${esc(w.name || 'unnamed webhook')}
        ${w.revoked_at ? '<span class="badge">revoked</span>' : ''}</div>
      <div class="muted">posts into #${esc(ch?.name || 'a channel you cannot see')}
        · created ${esc(relTime(w.created_at))}</div></div>`;
    if (!w.revoked_at) {
      const rev = el('button', 'sm ghost', 'Revoke');
      rev.onclick = async () => {
        const ok = await app.ui.confirmModal({
          title: 'Revoke webhook',
          body: 'Anything still posting with this token starts failing immediately. This cannot be undone.',
          confirmLabel: 'Revoke', danger: true,
        });
        if (!ok) return;
        try { await app.api.revokeWebhook(w.id); app.ui.toast('Revoked'); app.ui.refreshPanel(); }
        catch (e) { app.ui.toast(e.message, 'error'); }
      };
      row.appendChild(rev);
    }
    card.appendChild(row);
    host.appendChild(card);
  }
}

async function newWebhook() {
  const { ui, api, store } = app;
  const chans = store.channels.filter((c) => c.kind !== 'voice' && !c.archived_at);
  if (!chans.length) { ui.toast('Make a text channel first', 'error'); return; }
  const out = await ui.formModal({
    title: 'New incoming webhook',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'deploy-bot', required: true,
        hint: 'Shown next to every message this webhook posts.' },
      { name: 'channel', label: 'Posts into', type: 'select',
        options: chans.map((c) => ({ value: c.id, label: '#' + c.name })) },
    ],
    submitLabel: 'Create webhook',
    note: 'The token is shown once, on the next screen. It cannot be retrieved afterwards.',
  });
  if (!out) return;
  try {
    const token = await api.createWebhook(out.channel, out.name.trim());
    const ch = chans.find((c) => c.id === out.channel);
    const curl = [
      `curl -X POST '${WEBHOOK_URL}' \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"token":"${token}","text":"Build #42 is green","username":"ci"}'`,
    ].join('\n');
    secretModal({
      title: 'Webhook created',
      lead: `Anything POSTed with this token lands in #${ch?.name || 'the channel'} as a message. `
        + 'The token is the entire credential - there is no second factor - so treat it like a password.',
      token,
      blocks: [{ label: 'POST URL', code: WEBHOOK_URL }, { label: 'Try it', code: curl }],
    });
    ui.refreshPanel();
  } catch (e) { ui.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ bots
async function renderBots(host) {
  const { store, sb } = app;
  const canManage = hasPerm(PERM.MANAGE_WORKSPACE);
  const { data, error } = await sb.from('bots').select('*')
    .eq('workspace_id', store.ws.id).order('created_at', { ascending: false });
  host.innerHTML = '';
  if (error) { host.appendChild(el('div', 'empty', esc(error.message))); return; }

  host.appendChild(el('div', 'intg-mini',
    'A bot is a named identity with its own token. Unlike a webhook it is not tied to one channel - '
    + 'it picks the channel on every post.'));

  if (canManage) {
    const bar = el('div', 'row gap');
    const add = el('button', 'sm', 'New bot');
    add.onclick = () => newBot();
    bar.appendChild(add);
    host.appendChild(bar);
  }

  const rows = data || [];
  if (!rows.length) {
    host.appendChild(el('div', 'empty', canManage
      ? 'No bots yet. Create one to get a token a script can post with, without impersonating a person.'
      : 'No bots yet. Creating one needs the Manage workspace permission.'));
    return;
  }
  for (const b of rows) {
    const card = el('div', 'result');
    const row = el('div', 'intg-row');
    row.innerHTML = `<div class="intg-grow">
      <div class="intg-title">${esc(b.name || 'unnamed bot')}
        ${b.revoked_at ? '<span class="badge">revoked</span>' : ''}</div>
      <div class="muted">created ${esc(relTime(b.created_at))}</div></div>`;
    if (canManage && !b.revoked_at) {
      const rev = el('button', 'sm ghost', 'Revoke');
      rev.onclick = async () => {
        const ok = await app.ui.confirmModal({
          title: 'Revoke bot',
          body: 'Its token stops working immediately. Messages it already posted stay.',
          confirmLabel: 'Revoke', danger: true,
        });
        if (!ok) return;
        try { await app.api.revokeBot(b.id); app.ui.toast('Revoked'); app.ui.refreshPanel(); }
        catch (e) { app.ui.toast(e.message, 'error'); }
      };
      row.appendChild(rev);
    }
    card.appendChild(row);
    host.appendChild(card);
  }
}

async function newBot() {
  const { ui, api, store } = app;
  const out = await ui.formModal({
    title: 'New bot',
    fields: [{ name: 'name', label: 'Name', placeholder: 'release-bot', required: true,
      hint: 'Appears as the author of everything it posts.' }],
    submitLabel: 'Create bot',
    note: 'The token is shown once, on the next screen. It cannot be retrieved afterwards.',
  });
  if (!out) return;
  try {
    const token = await api.createBot(store.ws.id, out.name.trim());
    const chId = store.current?.id || '<channel-uuid>';
    const curl = [
      `curl -X POST '${BOT_RPC_URL}' \\`,
      `  -H 'apikey: ${PUBLISHABLE}' \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"p_token":"${token}","p_channel":"${chId}","p_body_text":"Deploy finished"}'`,
    ].join('\n');
    secretModal({
      title: 'Bot created',
      lead: 'Post as this bot by calling post_as_bot with its token. p_channel is any channel id in this '
        + 'workspace - the example below is prefilled with the channel you have open.',
      token,
      blocks: [{ label: 'Post as the bot', code: curl }],
    });
    ui.refreshPanel();
  } catch (e) { ui.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ slash commands
async function renderSlash(host) {
  const { ui, api, store } = app;
  const canManage = hasPerm(PERM.MANAGE_WORKSPACE);
  let rows;
  try {
    rows = await api.listSlashCommands(store.ws.id);
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(isDenied(e) || isMissing(e)
      ? 'Slash commands are unavailable in this workspace: ' + e.message
      : e.message)}</div>`;
    return;
  }
  host.innerHTML = '';
  host.appendChild(el('div', 'intg-mini',
    'Registered commands show up in the composer autocomplete. Typing one POSTs your argument text to its '
    + 'handler URL and shows the reply as plain text - a handler can never inject markup into the app.'));

  if (canManage) {
    const bar = el('div', 'row gap');
    const add = el('button', 'sm', 'Register command');
    add.onclick = () => newSlash();
    bar.appendChild(add);
    host.appendChild(bar);
  }

  if (!rows?.length) {
    host.appendChild(el('div', 'empty', canManage
      ? 'No commands registered. Register one and it appears here and in the composer, so /deploy or /oncall '
        + 'hits your own service.'
      : 'No commands registered. Registering one needs the Manage workspace permission.'));
    return;
  }
  for (const c of rows) {
    const card = el('div', 'result');
    const row = el('div', 'intg-row');
    row.innerHTML = `<div class="intg-grow">
      <div class="intg-title">/${esc(c.command)}</div>
      <div class="muted">${esc(c.description || 'no description')}</div>
      <div class="intg-mono">${esc(c.handler_url || 'no handler URL - typing it will do nothing')}</div></div>`;
    if (c.handler_url) {
      const test = el('button', 'sm ghost', 'Test');
      test.onclick = () => runHandler(c, '');
      row.appendChild(test);
    }
    card.appendChild(row);
    host.appendChild(card);
  }
}

async function newSlash() {
  const { ui, api, store } = app;
  const out = await ui.formModal({
    title: 'Register a slash command',
    fields: [
      { name: 'command', label: 'Command', placeholder: 'deploy', required: true,
        hint: 'Without the slash. Lowercased by the server.' },
      { name: 'description', label: 'Description', placeholder: 'Ship the current build',
        hint: 'Shown in the composer autocomplete.' },
      { name: 'handler_url', label: 'Handler URL', placeholder: 'https://example.com/hooks/deploy', required: true,
        hint: 'Receives a POST with the command, your text and the channel id.' },
    ],
    submitLabel: 'Register',
  });
  if (!out) return;
  const url = safeUrl(out.handler_url);
  if (!url) { ui.toast('Handler URL must be a http(s) address', 'error'); return; }
  try {
    await api.registerSlashCommand(store.ws.id, out.command.trim(), out.description.trim() || null, url);
    ui.toast('Registered');
    await syncSlashCommands();
    ui.refreshPanel();
  } catch (e) { ui.toast(e.message, 'error'); }
}

function safeUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : null;
  } catch { return null; }
}

// Handler URLs are supplied by whoever registered the command, so this is a call
// to an untrusted third party from inside the app. Credentials are omitted so
// none of our cookies travel, the referrer is suppressed, and the reply is
// flattened to plain text before it ever reaches the DOM.
async function runHandler(cmd, argText) {
  const { ui, store } = app;
  const url = safeUrl(cmd.handler_url);
  if (!url) { ui.toast(`/${cmd.command} has no usable handler URL`, 'error'); return; }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HANDLER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: '/' + cmd.command,
        text: argText || '',
        workspace_id: store.ws?.id ?? null,
        channel_id: store.current?.id ?? null,
        user_id: store.me ?? null,
      }),
      signal: ac.signal,
    });
    const raw = (await res.text()).slice(0, 2000);
    let reply = raw;
    // Slack-shaped handlers answer with {text: "..."}; anything else is read as text.
    try {
      const j = JSON.parse(raw);
      if (j && typeof j.text === 'string') reply = j.text;
      else if (typeof j === 'string') reply = j;
    } catch { /* not JSON, the raw body is the reply */ }
    const shown = plain(reply, 180) || (res.ok ? 'ok' : `HTTP ${res.status}`);
    ui.toast(`/${cmd.command}: ${shown}`, res.ok ? 'info' : 'error');
  } catch (e) {
    const why = e.name === 'AbortError' ? 'timed out'
      : /failed to fetch|networkerror/i.test(e.message || '') ? 'unreachable, or it does not allow CORS'
      : e.message;
    ui.toast(`/${cmd.command} failed: ${why}`, 'error');
  } finally {
    clearTimeout(timer);
  }
}

// Pull the registry into the composer autocomplete. Runs on every workspace
// switch, and never overwrites a command a core module or another feature owns.
async function syncSlashCommands() {
  const { ui, api, store } = app;
  if (!store.ws) return;
  let rows;
  try { rows = await api.listSlashCommands(store.ws.id); }
  catch { return; }  // no registry access is not an error worth a toast at boot
  for (const c of rows || []) {
    const name = String(c.command || '').replace(/^\//, '').toLowerCase();
    if (!name || !c.handler_url) continue;
    if (ui.findSlash(name) && !mySlash.has(name)) continue;
    mySlash.add(name);
    ui.addSlashCommand({
      name,
      description: c.description || 'Custom command',
      run: (argText) => runHandler({ command: name, handler_url: c.handler_url }, argText),
    });
  }
}

// ------------------------------------------------------------------ custom emoji
async function renderEmoji(host) {
  const { api, store } = app;
  const canManage = hasPerm(PERM.MANAGE_WORKSPACE);
  let rows;
  try {
    rows = await api.listCustomEmoji(store.ws.id);
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(isDenied(e) || isMissing(e)
      ? 'Custom emoji are unavailable in this workspace: ' + e.message
      : e.message)}</div>`;
    return;
  }
  host.innerHTML = '';
  host.appendChild(el('div', 'intg-mini',
    'Uploaded images become :shortcodes: anyone in this workspace can type.'));

  if (canManage) {
    const bar = el('div', 'row gap');
    const add = el('button', 'sm', 'Upload emoji');
    add.onclick = () => uploadEmoji();
    bar.appendChild(add);
    host.appendChild(bar);
  }

  if (!rows?.length) {
    host.appendChild(el('div', 'empty', canManage
      ? 'No custom emoji yet. Upload a square PNG and it becomes a :shortcode: for the whole workspace.'
      : 'No custom emoji yet. Uploading needs the Manage workspace permission.'));
    return;
  }
  const grid = el('div', 'intg-emoji');
  host.appendChild(grid);
  for (const e of rows) {
    const cell = el('div', 'intg-emoji-cell');
    cell.title = `Click to copy :${e.name}:`;
    cell.innerHTML = `<div class="intg-emoji-ph">🖼</div><div>:${esc(e.name)}:</div>`;
    cell.onclick = () => copy(`:${e.name}:`, `:${e.name}: copied`);
    grid.appendChild(cell);
    // Signed URLs are minted one at a time; do it after the grid is on screen so
    // the layout never waits on the media pipeline.
    mediaUrl(e.image_key).then((url) => {
      if (!url) return;
      const img = el('img');
      img.alt = ':' + e.name + ':';
      img.src = url;
      cell.replaceChild(img, cell.firstChild);
    }).catch(() => { /* the placeholder stays; a broken preview is not an error */ });
  }
}

async function uploadEmoji() {
  const { ui, api, store } = app;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    const out = await ui.formModal({
      title: 'Name this emoji',
      fields: [{ name: 'name', label: 'Shortcode', placeholder: 'shipit', required: true,
        hint: 'Lowercase letters, numbers, - and _. People will type it as :shipit:' }],
      submitLabel: 'Upload',
    });
    if (!out) return;
    const name = out.name.trim().toLowerCase().replace(/^:+|:+$/g, '');
    if (!EMOJI_RE.test(name)) {
      ui.toast('2 to 32 characters: lowercase letters, numbers, - or _', 'error');
      return;
    }
    const t = ui.toast('Uploading…', 'info', 120000);
    try {
      // Two steps on purpose: the media pipeline is content-addressed and hands
      // back an object key, and create_custom_emoji only ever takes that key.
      const up = await uploadFile(file);
      await api.createCustomEmoji(store.ws.id, name, up.object_key);
      t.remove();
      ui.toast(`:${name}: is ready - type it in any message`, 'success');
      ui.refreshPanel();
    } catch (e) {
      t.remove();
      ui.toast(e.message, 'error');
    }
  };
  inp.click();
}

// ------------------------------------------------------------------ register
export function register({ ui, api, store, bus, sb }) {
  app = { ui, api, store, bus, sb };
  injectStyle();

  ui.registerPanel({
    id: 'integrations',
    title: 'Integrations',
    async render(body) {
      body.innerHTML = '';
      if (!store.ws) {
        body.innerHTML = '<div class="empty">Open a workspace first. Webhooks, bots, commands and emoji '
          + 'all belong to one workspace.</div>';
        return;
      }
      body.appendChild(el('p', 'intg-lead muted',
        'Everything that lets an outside system talk to this workspace. Tokens are shown once, when they '
        + 'are created, and stored only as hashes.'));

      const sections = [
        ['Incoming webhooks', renderWebhooks],
        ['Bots', renderBots],
        ['Slash commands', renderSlash],
        ['Custom emoji', renderEmoji],
      ];
      // Each section owns its own loading, empty and error state, and is rendered
      // independently so one denied read cannot blank the whole panel.
      await Promise.all(sections.map(async ([title, fn]) => {
        const host = sectionShell(body, title);
        try { await fn(host); }
        catch (e) { host.innerHTML = `<div class="empty">${esc(e.message || 'failed to load')}</div>`; }
      }));
    },
  });

  ui.addHeaderButton({
    id: 'integrations',
    label: icon('plug'),
    title: 'Integrations - webhooks, bots, commands, emoji',
    order: 195,
    // MANAGE_CHANNELS is enough for webhooks alone, so admins of channels get in
    // too rather than seeing nothing. hasPerm already returns true for admins.
    show: () => hasPerm(PERM.MANAGE_WORKSPACE) || hasPerm(PERM.MANAGE_CHANNELS),
    onClick: () => ui.openPanel('integrations'),
  });

  ui.addSwitcherSource({
    id: 'integrations',
    search: (q) => {
      if (!hasPerm(PERM.MANAGE_WORKSPACE) && !hasPerm(PERM.MANAGE_CHANNELS)) return [];
      const hay = 'integrations webhooks bots slash commands emoji';
      if (q && !hay.includes(q.toLowerCase())) return [];
      return [{ label: 'Integrations', hint: 'Webhooks, bots, commands, emoji', icon: icon('plug'),
        run: () => ui.openPanel('integrations') }];
    },
  });

  // The registry lives per workspace, so re-read it on every switch.
  bus.on('workspace', () => { syncSlashCommands(); });
  if (store.ws) syncSlashCommands();
}
