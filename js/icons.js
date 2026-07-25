// A hand-built inline SVG icon set.
//
// The chrome used emoji (💬 🔔 🔖 🔍 📌 👥). Emoji are rendered by the operating
// system, so the same button is a flat glyph on Windows, a glossy 3D blob on
// Android and something else again on a Mac - three different products in three
// screenshots. These are drawn once, inherit currentColor so they follow the
// theme for free, and stay pixel-crisp at any size.
//
// All icons are on a 24x24 grid, 1.75 stroke, round caps and joins, so they sit
// together as one family. Emoji remain where they are CONTENT (reactions, custom
// status, a person's chosen emoji) - only interface chrome is drawn here.

const P = (d, extra = '') =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${extra ? ' ' + extra : ''}/>`;

export const ICONS = {
  // ---- navigation / panels ----
  thread: P('M21 11.5a8.4 8.4 0 0 1-9 8.4 9.1 9.1 0 0 1-3.3-.6L3 21l1.9-5a8.2 8.2 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.5-8.2 8.4 8.4 0 0 1 8.5 8z')
    + P('M8.5 10h7M8.5 13.5h4.5'),
  bell: P('M18 8.5a6 6 0 1 0-12 0c0 6-2 7.5-2 7.5h16s-2-1.5-2-7.5')
    + P('M13.7 20a2 2 0 0 1-3.4 0'),
  bookmark: P('M18.5 20 12 15.6 5.5 20V5.5A1.5 1.5 0 0 1 7 4h10a1.5 1.5 0 0 1 1.5 1.5z'),
  search: `<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('m20 20-4.7-4.7'),
  pin: P('M9 4h6l-.7 5.2 3 3.1V14H6.7v-1.7l3-3.1z') + P('M12 14v6'),
  members: `<circle cx="9.5" cy="8.5" r="3.3" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M3.5 19.5a6.2 6.2 0 0 1 12 0') + P('M16.5 6.2a3.3 3.3 0 0 1 0 6.4M17.6 14.4a6.2 6.2 0 0 1 3.4 5.1'),
  settings: `<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M19.2 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9z'),
  shield: P('M12 3.5 5 6.4v5c0 4.3 3 8.3 7 9.3 4-1 7-5 7-9.3v-5z') + P('m9.3 11.8 1.9 1.9 3.6-3.6'),
  plug: P('M9 3v5M15 3v5') + P('M7 8h10v3a5 5 0 0 1-10 0z') + P('M12 16v5'),
  clock: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>` + P('M12 7.4V12l3 1.8'),
  keyboard: P('M3.5 6.5h17v11h-17z') + P('M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8'),
  chart: P('M4 20V10M10 20V4M16 20v-7M22 20H2'),
  doc: P('M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z')
    + P('M14 3.5V7a.5.5 0 0 0 .5.5H18M9 12h6M9 15.5h6'),
  calendar: P('M5 6.5h14v13H5z') + P('M8 3.5v4M16 3.5v4M5 11h14'),
  hash: P('M5 9.5h14M5 14.5h14M10.2 4l-1.4 16M16 4l-1.4 16'),
  // A bullhorn, not a speaker cone - it sat next to `volume` and the two were
  // indistinguishable at 20px, which is where an icon set stops being a set.
  megaphone: P('M4 11.5v1.8a2 2 0 0 0 1.6 2l11.9 2.4a1 1 0 0 0 1.2-1V8.3a1 1 0 0 0-1.2-1L5.6 9.6a2 2 0 0 0-1.6 2z')
    + P('M7.5 15.6V19a1.5 1.5 0 0 0 3 0v-2.8') + P('M21 10.5v4'),
  lock: P('M6.5 10.5h11v9h-11z') + P('M9 10.5V8a3 3 0 0 1 6 0v2.5'),
  volume: P('M4 10v4a1 1 0 0 0 1 1h2.5L12 19V5L7.5 9H5a1 1 0 0 0-1 1z') + P('M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10'),

  // ---- message actions ----
  reply: P('M9 7 4 12l5 5') + P('M4 12h9a6 6 0 0 1 6 6v1'),
  forward: P('m15 7 5 5-5 5') + P('M20 12h-9a6 6 0 0 0-6 6v1'),
  smile: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M8.8 14a4 4 0 0 0 6.4 0') + P('M9.3 9.6h.01M14.7 9.6h.01'),
  more: `<circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/>`,
  plus: P('M12 5.5v13M5.5 12h13'),
  close: P('m6.5 6.5 11 11M17.5 6.5l-11 11'),
  check: P('m5 12.5 4.5 4.5L19 7.5'),
  trash: P('M4.5 7h15') + P('M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7')
    + P('M6.5 7l.8 12A1.5 1.5 0 0 0 8.8 20.5h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12'),
  edit: P('M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4z'),
  link: P('M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6')
    + P('M13.5 10.5a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.6-1.6'),

  // ---- composer ----
  paperclip: P('M20 11.5 12.3 19a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3'),
  send: P('m5 12 15-7-6 15-2.6-6z') + P('m11.4 14 8.6-9'),
  slash: P('M14.5 4 9.5 20'),
  code: P('m9 8-5 4 5 4M15 8l5 4-5 4'),
  image: P('M4.5 5.5h15v13h-15z') + P('m4.5 15.5 4-4 4 4 3-3 3.5 3.5')
    + `<circle cx="9" cy="9.5" r="1.3" fill="none" stroke="currentColor" stroke-width="1.75"/>`,
  mic: P('M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4z')
    + P('M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20'),
  micOff: P('M9.5 6.4A2.5 2.5 0 0 1 14.5 6.5v4M9.5 10.5v1a2.5 2.5 0 0 0 4.2 1.8')
    + P('M6.5 11a5.5 5.5 0 0 0 8.4 4.7M12 16.5V20') + P('m4 4 16 16'),
  headphones: P('M4 14v-2a8 8 0 0 1 16 0v2')
    + P('M4 14h2.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM20 14h-2.5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1z'),

  // ---- misc ----
  download: P('M12 4v11') + P('m7.5 11 4.5 4.5 4.5-4.5') + P('M4.5 19.5h15'),
  sun: `<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + P('M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'),
  moon: P('M20 14.3A8.5 8.5 0 1 1 9.7 4a6.6 6.6 0 0 0 10.3 10.3z'),
  contrast: `<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.75"/>`
    + `<path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor"/>`,
  menu: P('M4 7h16M4 12h16M4 17h16'),
  chevronDown: P('m7 10 5 5 5-5'),
  chevronRight: P('m10 7 5 5-5 5'),
  arrowDown: P('M12 5v13') + P('m6.5 12.5 5.5 5.5 5.5-5.5'),
  logout: P('M15 8V6a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 18v-2')
    + P('M19 12H9.5') + P('m16 9 3 3-3 3'),
};

// icon('search')            -> markup, sized by CSS
// icon('search', {size:18}) -> explicit size when a container cannot decide
export function icon(name, { size, cls = '' } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24"${dim} `
    + `aria-hidden="true" focusable="false">${body}</svg>`;
}

export const hasIcon = (name) => !!ICONS[name];

// The wordmark, used on the sign-in screen and as the fallback Space glyph.
// A flame in a rounded tile, matching the installed app icon so the browser tab,
// the home-screen icon and the sign-in screen are recognisably one product.
export function logoMark(size = 40) {
  return `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 48 48"
    aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="hearthFlame" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#e0562f"/>
        <stop offset="55%" stop-color="#f59245"/>
        <stop offset="100%" stop-color="#ffd08a"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="46" height="46" rx="13" fill="var(--c-nav-bg, #1a1030)"/>
    <path d="M24 8c1.6 6.2 6.4 8.6 8.9 12.9a11.6 11.6 0 0 1 1.6 5.9C34.5 33.9 29.8 40 24 40s-10.5-6.1-10.5-13.2c0-4.6 2.6-7.4 5-10.6C20.6 13.5 23 11.7 24 8z"
      fill="url(#hearthFlame)"/>
    <path d="M24 21c.9 3.1 3.6 4.6 3.6 8.2 0 2.9-1.6 5.3-3.6 5.3s-3.6-2.4-3.6-5.3c0-3.6 2.7-5.1 3.6-8.2z"
      fill="#fff3d6" opacity=".95"/>
  </svg>`;
}
