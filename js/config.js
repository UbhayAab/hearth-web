// Build-time config. Only client-safe values live here: the project URL and the
// publishable (anon) key. The secret key never reaches the browser.
export const SUPABASE_URL = 'https://ybddogqphinruyunnuwx.supabase.co';
export const PUBLISHABLE = 'sb_publishable_5gyvKj8AtZeXGDWVLYg3VA_Uwh4T4RD';

// Open demo Space. Anyone who lands without an invite link is dropped in here so
// the app is never an empty room. Real Spaces are joined via #/join/<token>.
export const DEMO_TOKEN = 'hearth-demo-open-2026';

export const APP_NAME = 'Soop';
export const APP_VENDOR = 'Redtree';
export const VERSION = '0.3.0';

// Permission bitfield, mirrored from the database (private.has_perm).
export const PERM = {
  SEND: 1n,
  MANAGE_MESSAGES: 2n,
  MANAGE_CHANNELS: 4n,
  MANAGE_ROLES: 8n,
  KICK: 16n,
  BAN: 32n,
  MANAGE_WORKSPACE: 64n,
  CREATE_INVITE: 128n,
  MENTION_EVERYONE: 256n,
  MODERATE: 512n,
  MANAGE_THREADS: 1024n,
  ADMINISTRATOR: 1n << 40n,
};

// Quick-react bar: the six shown on message hover without opening the picker.
export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MESSAGE_PAGE = 50;
