// Theme: dark, light, colorful (the Slack aubergine), or follow the OS.
//
// The choice is applied to <html data-theme> and persisted. An inline snippet in
// index.html applies it before first paint - doing it here alone would show a
// dark flash to a light-mode user on every load.
import { $, el, esc } from './util.js';
import { popover, toast } from './ui.js';

const KEY = 'hearth.theme';

export const THEMES = [
  {
    id: 'dark',
    name: 'Dark',
    hint: 'Low glare, easy on long evenings',
    swatch: ['#14161a', '#1a1d22', '#5b8cff'],
  },
  {
    id: 'light',
    name: 'Light',
    hint: 'Clean and crisp for bright rooms',
    swatch: ['#ffffff', '#f1f3f7', '#2f6fed'],
  },
  {
    id: 'colorful',
    name: 'Colorful',
    hint: 'Aubergine sidebar, light conversation',
    swatch: ['#3f0e40', '#ffffff', '#1264a3'],
  },
  {
    id: 'system',
    name: 'Match system',
    hint: 'Follow your device between light and dark',
    swatch: ['#14161a', '#ffffff', '#5b8cff'],
  },
];

const media = window.matchMedia('(prefers-color-scheme: dark)');

export const storedTheme = () => {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
};

// What is actually painted right now (never returns 'system').
export const effectiveTheme = () => {
  const t = storedTheme();
  if (t !== 'system') return t;
  return media.matches ? 'dark' : 'light';
};

export function applyTheme(choice) {
  const resolved = choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-choice', choice);

  // Keep the mobile browser chrome in step with the app, otherwise a light theme
  // sits under a black status bar and looks broken on a phone.
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--c-nav-bg').trim() || '#14161a';
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = bg;
}

export function setTheme(choice) {
  try { localStorage.setItem(KEY, choice); } catch { /* private mode */ }
  applyTheme(choice);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { choice } }));
}

export function initTheme() {
  applyTheme(storedTheme());
  // Only react to the OS while the user is actually following it.
  const onSystem = () => { if (storedTheme() === 'system') applyTheme('system'); };
  media.addEventListener ? media.addEventListener('change', onSystem) : media.addListener(onSystem);
}

// A compact picker with real swatches - people choose a theme by looking at it,
// not by reading its name.
export function openThemePicker(anchor) {
  const box = el('div', 'theme-picker');
  const current = storedTheme();
  box.innerHTML = THEMES.map((t) => `
    <button class="theme-option${t.id === current ? ' is-active' : ''}" data-theme-id="${t.id}" type="button">
      <span class="theme-swatch">
        ${t.swatch.map((c) => `<i style="background:${esc(c)}"></i>`).join('')}
      </span>
      <span class="theme-meta">
        <span class="theme-name">${esc(t.name)}</span>
        <span class="theme-hint">${esc(t.hint)}</span>
      </span>
      <span class="theme-check" aria-hidden="true">✓</span>
    </button>`).join('');

  const pop = popover(anchor, box, { below: true, cls: 'popover-theme' });
  box.querySelectorAll('[data-theme-id]').forEach((b) => {
    b.onclick = () => {
      setTheme(b.dataset.themeId);
      box.querySelectorAll('.theme-option').forEach((o) => o.classList.remove('is-active'));
      b.classList.add('is-active');
      setTimeout(() => pop.close(), 220);
    };
  });
  return pop;
}

// Cycle through the three concrete themes. Bound to a keyboard shortcut so it is
// quick to compare them.
export function cycleTheme() {
  const order = ['dark', 'light', 'colorful'];
  const i = order.indexOf(effectiveTheme());
  const next = order[(i + 1) % order.length];
  setTheme(next);
  toast(`${THEMES.find((t) => t.id === next).name} theme`);
}
