// Per-scope notification levels, quiet hours, desktop notifications and web push.
//
// Two rules shape this module. First, permission is only ever requested from a
// real click inside the panel: a browser that is asked on load says "block"
// forever and there is no way back from that. Second, the client never decides
// on its own that something is worth interrupting for - it re-uses exactly the
// same predicate the server uses (mention, or a channel explicitly set to "all")
// so the desktop toast and the push notification agree.
import { store, bus, nameOf } from '../store.js';
import { el, esc, plain } from '../util.js';
import { icon } from '../icons.js';

const MIN = 60000;
const HOUR = 3600000;

const LEVELS = [
  { value: 'inherit', label: 'Default' },
  { value: 'all', label: 'All' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'nothing', label: 'Nothing' },
];

const PAUSES = [
  { label: '30 minutes', ms: 30 * MIN },
  { label: '1 hour', ms: HOUR },
  { label: 'Until tomorrow', tomorrow: true },
];

// The VAPID application server public key. It is public by construction - the
// browser hands it to the push service in the clear on every subscribe - but the
// client config has no slot for it, so it is resolved at runtime with a
// deployment fallback. The matching private key stays in the web-push function.
const VAPID_FALLBACK = 'BMOAGjdDdmNngOJeTZvTnap0xG7U_QpGdo19fnvcPWXFQygmPW484rruKsGETRW77ad-D2RwoeYUtE3EdNNXJHs';
const vapidKey = () =>
  (typeof window !== 'undefined' && window.HEARTH_VAPID_PUBLIC_KEY) ||
  document.querySelector('meta[name="vapid-public-key"]')?.content ||
  VAPID_FALLBACK;

// Local mirror of notification_prefs so the message:new path never has to wait
// on a round trip to decide whether to stay quiet.
let prefs = {};

const tomorrowMorning = () => {
  const d = new Date(Date.now() + 86400000);
  d.setHours(9, 0, 0, 0);
  return d;
};

const hasNotificationApi = () => typeof Notification !== 'undefined';
const permission = () => (hasNotificationApi() ? Notification.permission : 'unsupported');

function mentionsMe(m) {
  if (Array.isArray(m.mention_user_ids) && m.mention_user_ids.includes(store.me)) return true;
  return m.mention_scope === 'here' || m.mention_scope === 'channel';
}

function paused() {
  return !!prefs.dnd_until && new Date(prefs.dnd_until).getTime() > Date.now();
}

// Quiet hours wrap midnight (22 -> 7 is the common case), so the comparison has
// to handle start > end.
function inQuietHours() {
  const s = prefs.quiet_start;
  const e = prefs.quiet_end;
  if (s == null || e == null || s === e) return false;
  const h = new Date().getHours();
  return s < e ? h >= s && h < e : h >= s || h < e;
}

// ------------------------------------------------------------------ web push
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushSupported = () =>
  'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window;

async function pushRegistration() {
  if (!pushSupported()) return null;
  try { return (await navigator.serviceWorker.getRegistration()) || null; } catch { return null; }
}

async function subscribeToPush(api) {
  const reg = await pushRegistration();
  if (!reg) throw new Error('The service worker is not registered on this page yet.');
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey()),
  });
  const j = sub.toJSON();
  if (!j.keys?.p256dh || !j.keys?.auth) throw new Error('The browser returned a subscription without keys.');
  await api.pushSubscribe(sub.endpoint, j.keys.p256dh, j.keys.auth, navigator.userAgent);
  return sub;
}

// ------------------------------------------------------------------ raising one
function raise(m) {
  if (!m || m.author_id === store.me) return;
  if (document.visibilityState !== 'hidden') return;
  if (permission() !== 'granted') return;
  if (paused() || inQuietHours()) return;

  const level = store.notify.get(m.channel_id)?.notify_level;
  if (level === 'nothing') return;
  if (!(mentionsMe(m) || level === 'all')) return;

  const ch = store.channels.find((c) => c.id === m.channel_id);
  const title = nameOf(m.author_id) + (ch ? ' in #' + ch.name : '');
  const body = plain(m.body_text, 140) ||
    (Array.isArray(m.attachments) && m.attachments.length ? 'sent an attachment' : 'sent a message');
  const url = m.channel_id && m.seq
    ? location.pathname + location.search + '#/m/' + m.channel_id + '/' + m.seq
    : location.pathname;
  const opts = {
    body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'hearth-' + (m.channel_id || 'msg'),
    data: { url, messageId: m.id },
  };

  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      n.close();
      if (m.id) bus.emit('message:jump', { messageId: m.id });
    };
  } catch {
    // Chrome on Android forbids the constructor entirely; the service worker
    // path is the only one that works there, and sw.js already handles the click.
    navigator.serviceWorker?.getRegistration()
      .then((reg) => reg?.showNotification(title, opts))
      .catch(() => {});
  }
}

// ------------------------------------------------------------------ panel
function seg(current, onPick) {
  const host = el('div', 'hnotif-seg');
  for (const lv of LEVELS) {
    const b = el('button', 'sm ghost' + (lv.value === current ? ' on' : ''), esc(lv.label));
    b.title = lv.value === 'inherit' ? 'Follow the Space default' : 'Notify me about ' + lv.label.toLowerCase();
    b.onclick = () => onPick(lv.value, b, host);
    host.appendChild(b);
  }
  return host;
}

const hourOptions = (selected) => Array.from({ length: 24 }, (_, h) =>
  `<option value="${h}"${h === selected ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

function renderPanel(ui, api) {
  return async function render(body) {
    body.innerHTML = '<div class="muted pad">loading…</div>';
    if (!store.ws) {
      body.innerHTML = '<div class="empty">Open a Space first. Notification levels are stored per Space, per channel.</div>';
      return;
    }

    let data;
    try {
      data = await api.notifySettings(store.ws.id);
    } catch (e) {
      body.innerHTML = `<div class="empty">Could not load your notification settings.<br>${esc(e.message)}</div>`;
      return;
    }
    prefs = data?.prefs || {};
    const levels = new Map((data?.channels || []).map((c) => [c.scope_id, c.notify_level]));

    body.innerHTML = '';

    // ---------------- quiet hours ----------------
    body.appendChild(el('h4', 'sec', 'Quiet hours'));
    const qh = el('div', 'hnotif-block', `
      <div class="hnotif-hours">
        <label class="field"><span class="field-label">From</span>
          <select data-q="start">${hourOptions(prefs.quiet_start ?? 22)}</select></label>
        <label class="field"><span class="field-label">Until</span>
          <select data-q="end">${hourOptions(prefs.quiet_end ?? 7)}</select></label>
        <button class="sm" data-a="qh">Save</button>
      </div>
      <div class="muted hnotif-hint">${prefs.quiet_start == null
        ? 'Not set. Pick a window and nothing will interrupt you inside it.'
        : `Silent between ${String(prefs.quiet_start).padStart(2, '0')}:00 and ${String(prefs.quiet_end).padStart(2, '0')}:00.`}</div>`);
    body.appendChild(qh);
    qh.querySelector('[data-a="qh"]').onclick = async () => {
      const s = +qh.querySelector('[data-q="start"]').value;
      const e = +qh.querySelector('[data-q="end"]').value;
      try {
        const row = await api.setQuietHours(s, e);
        prefs = { ...prefs, quiet_start: row?.quiet_start ?? s, quiet_end: row?.quiet_end ?? e };
        ui.toast('Quiet hours saved');
        ui.refreshPanel();
      } catch (err) { ui.toast(err.message || 'Could not save quiet hours', 'error'); }
    };

    // ---------------- do not disturb ----------------
    body.appendChild(el('h4', 'sec', 'Pause notifications'));
    const dnd = el('div', 'hnotif-block');
    const paintDnd = () => {
      dnd.innerHTML = `<div class="muted hnotif-hint">${paused()
        ? 'Paused until ' + esc(new Date(prefs.dnd_until).toLocaleString([], { hour: '2-digit', minute: '2-digit' }))
        : 'Not paused. Mentions and channels set to All will interrupt you.'}</div>`;
      const row = el('div', 'row gap hnotif-seg');
      for (const opt of PAUSES) {
        const b = el('button', 'sm ghost', esc(opt.label));
        b.onclick = async () => {
          const at = opt.tomorrow ? tomorrowMorning() : new Date(Date.now() + opt.ms);
          try {
            const r = await api.setDnd(at.toISOString());
            prefs = { ...prefs, dnd_until: r?.dnd_until || at.toISOString() };
            paintDnd();
            ui.toast('Notifications paused');
          } catch (e) { ui.toast(e.message || 'Could not pause notifications', 'error'); }
        };
        row.appendChild(b);
      }
      if (paused()) {
        const off = el('button', 'sm ghost', 'Resume now');
        off.onclick = async () => {
          try {
            await api.setDnd(null);
            prefs = { ...prefs, dnd_until: null };
            paintDnd();
            ui.toast('Notifications resumed');
          } catch (e) { ui.toast(e.message || 'Could not resume notifications', 'error'); }
        };
        row.appendChild(off);
      }
      dnd.appendChild(row);
    };
    paintDnd();
    body.appendChild(dnd);

    // ---------------- desktop notifications ----------------
    body.appendChild(el('h4', 'sec', 'This device'));
    const dev = el('div', 'hnotif-block');
    const paintDevice = () => {
      dev.innerHTML = '';
      const p = permission();
      const line = el('div', 'muted hnotif-hint');
      dev.appendChild(line);

      if (p === 'unsupported') {
        line.textContent = 'This browser has no Notification API, so desktop alerts are not available here.';
      } else if (p === 'denied') {
        line.textContent = 'Notifications are blocked for this site in your browser settings. Re-allow them there and reopen this panel.';
      } else if (p === 'granted') {
        line.textContent = 'Desktop notifications are on. You get one when a message mentions you, or arrives in a channel set to All, while Hearth is in the background.';
        const test = el('button', 'sm ghost', 'Send a test notification');
        test.onclick = () => {
          try { new Notification('Hearth', { body: 'This is what a notification looks like.', icon: './icons/icon-192.png' }); }
          catch { ui.toast('The browser refused to show it from this page', 'error'); }
        };
        dev.appendChild(test);
      } else {
        line.textContent = 'Desktop notifications are off. Turning them on lets Hearth alert you while it is in the background.';
        const ask = el('button', 'sm', 'Turn on desktop notifications');
        ask.onclick = async () => {
          try {
            const res = await Notification.requestPermission();
            ui.toast(res === 'granted' ? 'Desktop notifications on' : 'Permission not granted',
              res === 'granted' ? 'success' : 'info');
          } catch (e) { ui.toast(e.message || 'The browser refused the request', 'error'); }
          paintDevice();
        };
        dev.appendChild(ask);
      }

      // ---- web push ----
      const pushLine = el('div', 'muted hnotif-hint');
      dev.appendChild(pushLine);
      const key = vapidKey();
      if (!pushSupported()) {
        pushLine.textContent = 'Web push needs a service worker and the Push API, which this browser does not offer. Desktop notifications above still work while Hearth is open.';
      } else if (!key) {
        pushLine.textContent = 'Web push is unavailable: this deployment has not published a VAPID public key to the client, and a subscription cannot be created without one.';
        const b = el('button', 'sm ghost', 'Send pushes to this device');
        b.disabled = true;
        dev.appendChild(b);
      } else {
        pushLine.textContent = 'Web push reaches you even when Hearth is closed.';
        const b = el('button', 'sm ghost', 'Send pushes to this device');
        b.onclick = async () => {
          b.disabled = true;
          try {
            if (permission() !== 'granted') {
              const res = await Notification.requestPermission();
              if (res !== 'granted') { ui.toast('Push needs notification permission', 'error'); return; }
            }
            await subscribeToPush(api);
            ui.toast('This device is subscribed to push', 'success');
            pushLine.textContent = 'This device is subscribed to push.';
          } catch (e) {
            ui.toast(e.message || 'Could not subscribe to push', 'error');
            pushLine.textContent = 'Push subscription failed: ' + (e.message || 'unknown error');
          } finally { b.disabled = false; }
        };
        dev.appendChild(b);
        pushRegistration().then(async (reg) => {
          if (!reg) {
            pushLine.textContent = 'The service worker has not taken control of this page yet. Reload once, then subscribe.';
            b.disabled = true;
            return;
          }
          const sub = await reg.pushManager.getSubscription().catch(() => null);
          if (sub) { pushLine.textContent = 'This device is already subscribed to push.'; b.textContent = 'Re-register this device'; }
        }).catch(() => {});
      }
    };
    paintDevice();
    body.appendChild(dev);

    // ---------------- per channel ----------------
    body.appendChild(el('h4', 'sec', 'Channels'));
    const channels = store.channels.filter((c) => c.kind !== 'voice' && !c.archived_at);
    if (!channels.length) {
      body.appendChild(el('div', 'empty',
        'No channels you can see yet. Every channel you join appears here with its own notification level.'));
      return;
    }
    for (const c of channels) {
      const row = el('div', 'hnotif-row');
      row.appendChild(el('div', 'hnotif-name',
        `<span class="ch-ico">${c.is_private ? '🔒' : '#'}</span> ${esc(c.name)}`));
      row.appendChild(seg(levels.get(c.id) || 'inherit', async (value, btn, host) => {
        const prev = levels.get(c.id) || 'inherit';
        host.querySelectorAll('button').forEach((n) => n.classList.remove('on'));
        btn.classList.add('on');
        try {
          await api.setNotifyLevel('channel', c.id, value, null);
          levels.set(c.id, value);
          store.notify.set(c.id, { ...(store.notify.get(c.id) || {}), notify_level: value });
          // the sidebar dims muted channels, so it has to hear about this
          import('../core/channels.js').then((m) => m.renderChannels()).catch(() => {});
        } catch (e) {
          host.querySelectorAll('button').forEach((n) => n.classList.remove('on'));
          [...host.children][LEVELS.findIndex((l) => l.value === prev)]?.classList.add('on');
          ui.toast(e.message || 'Could not change the level', 'error');
        }
      }));
      body.appendChild(row);
    }
  };
}

// ------------------------------------------------------------------ register
export function register({ ui, api }) {
  injectStyle();

  ui.registerPanel({
    id: 'notifications',
    title: 'Notifications',
    render: renderPanel(ui, api),
  });

  ui.addHeaderButton({
    id: 'notifications',
    label: icon('bell'),
    title: 'Notification settings',
    order: 85,
    onClick: () => ui.openPanel('notifications'),
  });

  ui.addSlashCommand({
    name: 'notify',
    description: 'Set this channel to all, mentions, nothing or default',
    run: async (arg) => {
      if (!store.current) { ui.toast('Open a channel first', 'error'); return; }
      const want = (arg || '').trim().toLowerCase() || 'all';
      const lv = want === 'default' ? 'inherit' : want;
      if (!LEVELS.some((l) => l.value === lv)) {
        ui.toast('Use /notify all, mentions, nothing or default', 'error');
        return;
      }
      await api.setNotifyLevel('channel', store.current.id, lv, null);
      store.notify.set(store.current.id, { ...(store.notify.get(store.current.id) || {}), notify_level: lv });
      import('../core/channels.js').then((m) => m.renderChannels()).catch(() => {});
      ui.toast('#' + store.current.name + ' set to ' + (lv === 'inherit' ? 'default' : lv));
    },
  });

  // A failure here must never break the message render path.
  bus.on('message:new', ({ msg }) => { try { raise(msg); } catch { /* ignore */ } });

  // Keep the quiet-hours and pause mirror warm without a panel ever being opened.
  const sync = async () => {
    if (!store.ws) return;
    try { prefs = (await api.notifySettings(store.ws.id))?.prefs || {}; }
    catch { /* the defaults simply mean "nothing is muted" */ }
  };
  bus.on('workspace', sync);
  bus.on('auth', sync);
}

// ------------------------------------------------------------------ style
function injectStyle() {
  if (document.getElementById('hnotif-style')) return;
  const s = document.createElement('style');
  s.id = 'hnotif-style';
  s.textContent = `
    .hnotif-block{padding:2px 4px 10px;display:flex;flex-direction:column;gap:8px}
    .hnotif-hours{display:flex;gap:8px;align-items:flex-end}
    .hnotif-hours .field{margin:0;flex:1}
    .hnotif-hint{font-size:12px;line-height:1.5}
    .hnotif-seg{display:flex;gap:4px;flex-wrap:wrap}
    .hnotif-seg button{padding:4px 8px;font-size:12px}
    .hnotif-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--line)}
    .hnotif-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
    @media (max-width:860px){ .hnotif-row{flex-direction:column;align-items:stretch} }`;
  document.head.appendChild(s);
}
