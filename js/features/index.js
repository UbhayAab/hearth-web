// Feature registry.
//
// Every feature lives in its own file and exports `register(app)`. They are
// loaded dynamically and independently: one feature failing to load never takes
// the app down with it, and adding a feature means adding a filename here and
// nothing else. That is what lets features be built in parallel.
const FEATURES = [
  'polls',
  'events',
  'canvases',
  'topics',
  'forum',
  'later',
  'status',
  'admin',
  'moderation',
  'integrations',
  'messageExtras',
  'onboarding',
  'roles',
  'snippets',
  'bookmarks',
  'notifications',
  'shortcuts',
];

export async function registerFeatures(app) {
  const loaded = [];
  await Promise.all(FEATURES.map(async (name) => {
    try {
      const mod = await import(`./${name}.js`);
      if (typeof mod.register === 'function') {
        await mod.register(app);
        loaded.push(name);
      }
    } catch (e) {
      // A missing or broken feature module is a degraded app, not a dead one.
      if (!/Failed to fetch|not found|404/i.test(e.message || '')) {
        console.warn(`[hearth] feature "${name}" failed to load:`, e);
      }
    }
  }));
  console.info('[hearth] features loaded:', loaded.join(', ') || 'none');
  return loaded;
}
