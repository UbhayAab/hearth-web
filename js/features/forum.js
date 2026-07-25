// Forum channels - Discord's answer to "this channel is a Q&A board, not a room".
//
// A forum channel's messages are not a stream, they are posts: the server turns
// each one into a titled, elevated thread with tags. So a flat message list is
// the wrong view for it, and this module takes over #messages while such a
// channel is open and draws the board instead. Switching to a normal channel
// hands the list straight back - core repaints it on its own.
import { hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, relTime, plain } from '../util.js';
import { table } from '../api.js';
import { avatarHtml, buildMessage } from '../core/messages.js';
import { icon } from '../icons.js';

let ui, api, store, bus, sb;

let owned = null;       // the forum channel whose board we are painting
let filterTag = null;   // active tag filter, null = all
let observer = null;    // watches #messages so core cannot paint over us
let repaintTimer = null;
let paintToken = 0;
let painting = false;   // our own writes must not retrigger the observer
let wasForum = false;

export function register(app) {
  ({ ui, api, store, bus, sb } = app);
  injectStyle();

  ui.registerPanel({
    id: 'forum-post',
    title: (ctx) => (ctx && ctx.post ? ctx.post.title : 'Forum post'),
    render: renderPostPanel,
  });

  ui.addHeaderButton({
    id: 'forum-new', label: icon('plus'), title: 'New forum post', order: 45,
    show: () => store.current?.kind === 'forum',
    onClick: () => (owned ? newPostDialog(owned) : ui.toast('Open a forum channel first', 'error')),
  });

  ui.addSlashCommand({
    name: 'post',
    description: 'Start a post in this forum channel',
    run: (arg) => {
      if (store.current?.kind !== 'forum') {
        ui.toast('#' + (store.current?.name || 'this channel') + ' is not a forum channel', 'error');
        return;
      }
      newPostDialog(store.current, arg);
    },
  });

  bus.on('channel:open', ({ channel }) => onChannelOpen(channel));
  bus.on('dm:open', () => release());
}

// ------------------------------------------------------------------ ownership
function onChannelOpen(channel) {
  release();
  const isForum = channel?.kind === 'forum';
  // The New post button belongs to a forum channel, so the header row has to be
  // re-evaluated whenever we cross that line. Only then - it is a shared registry.
  if (isForum !== wasForum) { wasForum = isForum; ui.renderHeaderButtons(); }
  if (!isForum) return;

  owned = channel;
  filterTag = null;
  const composer = $('composer');
  if (composer) composer.placeholder = 'Use ✚ New post to start a thread in #' + channel.name;
  paint();
  watch();
}

function release() {
  owned = null;
  paintToken++;
  clearTimeout(repaintTimer);
  observer?.disconnect();
  observer = null;
}

// openChannel() emits channel:open BEFORE it loads and repaints the message
// list, so core will paint over whatever we draw. Watch the list and take it
// back. The same observer doubles as the live refresh: a reply or a new post
// arriving as a broadcast also lands in #messages, and a repaint is exactly the
// right response to it.
function watch() {
  const host = $('messages');
  if (!host || typeof MutationObserver !== 'function') return;
  observer = new MutationObserver(() => {
    if (painting) return;
    if (!owned || store.current?.id !== owned.id) return;
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(paint, 200);
  });
  observer.observe(host, { childList: true });
}

// Every DOM write to #messages goes through here so the observer can tell our
// paints from core's. The flag is cleared on a macrotask, after the observer's
// microtask callback has already seen it set.
function write(host, fn) {
  painting = true;
  try { fn(); } finally { setTimeout(() => { painting = false; }, 0); }
}

// ------------------------------------------------------------------ the board
async function paint() {
  const ch = owned;
  const host = $('messages');
  if (!ch || !host || store.current?.id !== ch.id) return;
  const token = ++paintToken;

  write(host, () => {
    host.innerHTML = '';
    host.appendChild(el('div', 'muted pad', 'loading posts…'));
  });

  // Tags and threads read through RLS and never throw; only the post list can.
  const [tags, threads] = await Promise.all([
    table('forum_tags', (q) => q.eq('channel_id', ch.id).order('name')),
    table('threads', (q) => q.eq('channel_id', ch.id)),
  ]);
  let posts = [];
  let err = null;
  try { posts = (await api.listForumPosts(ch.id, filterTag)) || []; } catch (e) { err = e; }
  if (token !== paintToken || store.current?.id !== ch.id) return;

  const byThread = new Map(threads.map((t) => [t.id, t]));
  const board = el('div', 'forum-board');
  board.appendChild(toolbar(ch, tags));

  if (err) {
    const box = el('div', 'empty', `Could not load the posts: ${esc(err.message)}`);
    const retry = el('button', 'ghost sm', 'Try again');
    retry.onclick = () => paint();
    box.appendChild(el('div', 'forum-retry')).appendChild(retry);
    board.appendChild(box);
  } else if (!posts.length) {
    board.appendChild(el('div', 'empty', filterTag
      ? 'No posts carry that tag yet. Clear the filter to see the whole board.'
      : `No posts in <b>#${esc(ch.name)}</b> yet. A forum channel holds titled posts
         instead of a stream - start the first one with <b>✚ New post</b>.`));
  } else {
    for (const p of posts) board.appendChild(postCard(ch, p, byThread.get(p.thread_id)));
  }

  write(host, () => { host.innerHTML = ''; host.appendChild(board); });
}

function toolbar(ch, tags) {
  const bar = el('div', 'forum-bar');
  const chips = el('div', 'forum-tags');
  const chip = (id, label) => {
    const b = el('button', 'chip forum-chip' + ((filterTag || '') === (id || '') ? ' on' : ''), esc(label));
    b.onclick = () => { filterTag = id || null; paint(); };
    return b;
  };
  chips.appendChild(chip(null, 'All posts'));
  for (const t of tags) chips.appendChild(chip(t.id, t.name));
  if (!tags.length) chips.appendChild(el('span', 'muted forum-notags', 'No tags yet'));
  bar.appendChild(chips);

  const tools = el('div', 'row gap forum-tools');
  const nu = el('button', 'sm', '✚ New post');
  nu.onclick = () => newPostDialog(ch);
  tools.appendChild(nu);
  if (hasPerm(PERM.MANAGE_CHANNELS)) {
    const mt = el('button', 'ghost sm', 'Manage tags');
    mt.onclick = () => manageTagsDialog(ch);
    tools.appendChild(mt);
  }
  bar.appendChild(tools);
  return bar;
}

function postCard(ch, post, thread) {
  const card = el('div', 'forum-card');
  const replies = post.reply_count || 0;
  const last = thread?.last_message_at || post.created_at;
  const tags = Array.isArray(post.tags) ? post.tags : [];
  card.innerHTML = `
    <div class="fc-title">${esc(post.title)}</div>
    <div class="fc-meta">${avatarHtml(post.author, 18)}
      <b>${esc(nameOf(post.author))}</b>
      <span class="muted">started ${esc(relTime(post.created_at))}</span></div>
    ${tags.length ? `<div class="fc-tags">${tags
      .map((t) => `<span class="chip forum-chip forum-chip-static">${esc(t.name)}</span>`).join('')}</div>` : ''}
    <div class="fc-foot muted">${replies} ${replies === 1 ? 'reply' : 'replies'}
      · last activity ${esc(relTime(last))}</div>`;
  card.onclick = () => openPost(ch, post, thread);
  return card;
}

const nameOf = (id) => {
  const p = store.profiles.get(id);
  return (id === store.me ? store.myProfile?.display_name : null) || p?.display_name || p?.username || 'someone';
};

// ------------------------------------------------------------------ open a post
// A post IS a thread, so the right home for it is the thread panel everyone
// already knows. Only when the root message is unreachable do we fall back to
// our own read-only rendering.
async function openPost(ch, post, thread) {
  const rootId = thread?.root_message_id;
  if (rootId) {
    const { data } = await sb.from('messages').select('*').eq('id', rootId).maybeSingle();
    if (data) { bus.emit('thread:request', { message: data }); return; }
  }
  ui.openPanel('forum-post', { post, threadId: post.thread_id, channelName: ch?.name || '' });
}

async function renderPostPanel(body, ctx = {}) {
  const post = ctx.post;
  const threadId = ctx.threadId || post?.thread_id;
  if (!threadId) {
    body.innerHTML = `<div class="empty">No post open. Open a forum channel and pick a post -
      each post is a titled thread with its own replies and tags.</div>`;
    return;
  }

  body.innerHTML = '<div class="muted pad">loading…</div>';
  let msgs;
  try {
    msgs = (await api.threadMessages(threadId)) || [];
  } catch (e) {
    body.innerHTML = `<div class="empty">Could not load this post: ${esc(e.message)}</div>`;
    return;
  }

  body.innerHTML = '';
  const head = el('div', 'forum-posthead');
  const tags = Array.isArray(post?.tags) ? post.tags : [];
  head.innerHTML = `
    <div class="fp-title">${esc(post?.title || 'Post')}</div>
    <div class="muted">in #${esc(ctx.channelName || store.current?.name || '')}
      ${post?.created_at ? '· ' + esc(relTime(post.created_at)) : ''}</div>
    ${tags.length ? `<div class="fc-tags">${tags
      .map((t) => `<span class="chip forum-chip forum-chip-static">${esc(t.name)}</span>`).join('')}</div>` : ''}`;
  body.appendChild(head);

  if (!msgs.length) {
    body.appendChild(el('div', 'empty',
      'This post has no readable messages. It may have been deleted after the board was drawn.'));
    return;
  }

  const list = el('div', 'forum-postmsgs');
  for (const m of msgs) {
    const row = buildMessage(m, { context: 'static' });
    // The same message can already be on screen elsewhere; a duplicate element
    // id would hijack every jump-to-message in the app.
    row.removeAttribute('id');
    list.appendChild(row);
  }
  body.appendChild(list);
}

// ------------------------------------------------------------------ new post
// formModal cannot do a multi-select, and tags are the reason a forum beats a
// channel, so the picker is hand-rolled.
async function newPostDialog(ch, prefillTitle = '') {
  const tags = await table('forum_tags', (q) => q.eq('channel_id', ch.id).order('name'));
  const chosen = new Set(filterTag ? [filterTag] : []);

  const box = el('div', 'form');
  box.innerHTML = `
    <label class="field"><span class="field-label">Title</span>
      <input id="fpTitle" maxlength="200" placeholder="How do I rotate the signing key?"
        value="${esc(prefillTitle || '')}" /></label>
    <label class="field"><span class="field-label">Post</span>
      <textarea id="fpBody" rows="6" placeholder="Give people enough to answer without asking twice."></textarea></label>
    <div class="field"><span class="field-label">Tags</span>
      <div class="forum-tagpick" id="fpTags"></div></div>`;

  const pick = box.querySelector('#fpTags');
  if (!tags.length) {
    pick.appendChild(el('span', 'muted', hasPerm(PERM.MANAGE_CHANNELS)
      ? 'No tags in this channel yet. Add some from Manage tags.'
      : 'No tags in this channel yet.'));
  }
  for (const t of tags) {
    const b = el('button', 'chip forum-chip' + (chosen.has(t.id) ? ' on' : ''), esc(t.name));
    b.type = 'button';
    b.onclick = () => {
      if (chosen.has(t.id)) chosen.delete(t.id); else chosen.add(t.id);
      b.classList.toggle('on', chosen.has(t.id));
    };
    pick.appendChild(b);
  }

  ui.modal({
    title: 'New post in #' + ch.name,
    body: box,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: (close) => close() },
      {
        label: 'Post',
        onClick: async (close) => {
          const title = box.querySelector('#fpTitle').value.trim();
          const text = box.querySelector('#fpBody').value.trim();
          if (!title) { ui.toast('A post needs a title', 'error'); return; }
          close();
          try {
            const post = await api.createForumPost(ch.id, title, text, [...chosen]);
            ui.toast('Posted', 'success');
            paint();
            const rows = post?.thread_id
              ? await table('threads', (q) => q.eq('id', post.thread_id))
              : [];
            openPost(ch, { ...post, tags: tags.filter((t) => chosen.has(t.id)) }, rows[0]);
          } catch (e) { ui.toast(e.message, 'error'); }
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ tags
async function manageTagsDialog(ch) {
  const box = el('div', 'form');
  box.innerHTML = `
    <div id="ftList" class="forum-tagpick"><span class="muted">loading…</span></div>
    <label class="field"><span class="field-label">Add a tag</span>
      <input id="ftName" maxlength="40" placeholder="bug" />
      <span class="field-hint">Tags are how a forum stays searchable once it has a hundred posts.</span></label>`;

  const dlg = ui.modal({
    title: 'Tags in #' + ch.name,
    body: box,
    actions: [
      { label: 'Done', kind: 'ghost', onClick: (close) => { close(); paint(); } },
      { label: 'Add tag', onClick: () => add() },
    ],
  });

  const list = box.querySelector('#ftList');
  const draw = async () => {
    const tags = await table('forum_tags', (q) => q.eq('channel_id', ch.id).order('name'));
    list.innerHTML = '';
    if (!tags.length) {
      list.appendChild(el('span', 'muted', 'No tags yet. The first one you add shows up on the board filter.'));
      return;
    }
    for (const t of tags) list.appendChild(el('span', 'chip forum-chip forum-chip-static', esc(t.name)));
  };

  const add = async () => {
    const input = box.querySelector('#ftName');
    const name = input.value.trim();
    if (!name) { ui.toast('Give the tag a name', 'error'); return; }
    try {
      await api.createForumTag(ch.id, name);
      input.value = '';
      ui.toast('Tag added', 'success');
      draw();
    } catch (e) { ui.toast(e.message, 'error'); }
  };

  box.querySelector('#ftName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  });
  draw();
  return dlg;
}

// ------------------------------------------------------------------ styles
function injectStyle() {
  if (document.getElementById('forum-style')) return;
  const s = document.createElement('style');
  s.id = 'forum-style';
  s.textContent = `
    .forum-board{padding:8px 10px 24px;max-width:860px;margin:0 auto}
    .forum-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--line)}
    .forum-tags{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
    .forum-tools{margin-left:auto;flex:none}
    .forum-notags{font-size:12px}
    .forum-chip{cursor:pointer;color:var(--dim);font-weight:600}
    .forum-chip:hover{color:var(--text);border-color:var(--dim)}
    .forum-chip.on{border-color:var(--accent);color:var(--accent);background:var(--me)}
    .forum-chip-static{cursor:default;font-weight:500}
    .forum-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
      padding:11px 13px;margin-bottom:8px;cursor:pointer;transition:border-color .12s,background .12s}
    .forum-card:hover{border-color:var(--accent);background:var(--panel2)}
    .fc-title{font-size:15.5px;font-weight:700;margin-bottom:4px;word-break:break-word}
    .fc-meta{display:flex;align-items:center;gap:6px;font-size:12.5px;flex-wrap:wrap}
    .fc-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
    .fc-foot{font-size:12px;margin-top:7px}
    .forum-retry{margin-top:10px}
    .forum-posthead{padding:2px 4px 8px;border-bottom:1px solid var(--line);margin-bottom:6px}
    .fp-title{font-size:16px;font-weight:700;word-break:break-word;margin-bottom:3px}
    .forum-postmsgs .msg .gutter{width:34px}
    .forum-tagpick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
  `;
  document.head.appendChild(s);
}
