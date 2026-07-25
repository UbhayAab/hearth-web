// Install + offline. Two very different platforms:
//   Chromium (Android, desktop) fires beforeinstallprompt, so we stash it and
//   call prompt() from a real click - the only thing the browser accepts.
//   iOS Safari has no such API at all: the honest answer is a sheet that shows
//   the exact Share -> Add to Home Screen steps. Pretending otherwise would just
//   produce a button that does nothing.
import { $, el, esc } from './util.js';
import { modal, toast } from './ui.js';

let deferredPrompt = null;

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const ua = navigator.userAgent;
export const isIOS = /iPad|iPhone|iPod/.test(ua) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isIOSSafari = isIOS && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

export function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then((reg) => {
        // Never swap the running bundle mid-conversation. Offer it instead.
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw?.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(reg);
          });
        });
      })
      .catch((e) => console.warn('sw register failed', e));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    paintInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    paintInstallButton();
    toast('Soop installed. Look for it with your other apps.');
  });

  paintInstallButton();

  // Persistent storage keeps the offline cache and the session from being evicted.
  navigator.storage?.persist?.().catch(() => {});
}

export function canInstall() {
  if (isStandalone()) return false;
  return !!deferredPrompt || isIOSSafari;
}

export function paintInstallButton() {
  const b = $('installBtn');
  if (!b) return;
  b.classList.toggle('hidden', !canInstall());
  b.onclick = promptInstall;
}

export async function promptInstall() {
  if (isStandalone()) { toast('Already installed'); return; }
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') toast('Installing…');
    deferredPrompt = null;
    paintInstallButton();
    return;
  }
  if (isIOS) return iosSheet();
  modal({
    title: 'Install Soop',
    body: `<p>Your browser has not offered an install prompt yet. Use the browser menu and choose
      <b>Install app</b> or <b>Add to Home screen</b>.</p>
      <p class="muted">On Chrome or Edge desktop the install icon also appears at the right edge of the address bar.</p>`,
  });
}

function iosSheet() {
  modal({
    title: 'Add Soop to your Home Screen',
    body: `
      <ol class="ios-steps">
        <li>Tap the <b>Share</b> button <span class="ios-ico">􀈂</span> at the bottom of Safari.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b>. Soop opens full screen, like an app.</li>
      </ol>
      ${isIOSSafari ? '' :
        '<p class="muted">You are not in Safari. On iPhone only Safari can add an app to the Home Screen - open this page in Safari first.</p>'}`,
  });
}

function showUpdateToast(reg) {
  const t = toast('A new version of Soop is ready.', 'info', 20000);
  const b = el('button', 'sm', 'Reload');
  b.onclick = () => {
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => location.reload(), 250);
  };
  t.appendChild(b);
}
