// Scores the watcher against what really happened in the recording (in order).
const { watchVideo, describe } = await import(new URL('../../dist/video/watch.js', import.meta.url).pathname);
const expected = [
  ['click', /"Next".*Set smart budgets/],
  ['click', /"Next".*Create your account/],
  ['click', /"Email address"/],
  ['type', /"ana@example\.com" into "Email address"/],
  ['click', /"Password"/],
  ['type', /into "Password" \(hidden/],
  ['click', /"Sign up".*error "Password must be at least 8 characters"/],
  ['click', /"Password"/],
  ['type', /into "Password" \(hidden/],
  ['click', /"Sign up".*Good morning, Ana.*after loading/],
  ['scroll', /scrolled down about 4\d\d px/],
  ['scroll', /tried to scroll down.*already at the end/],
  ['click', /"Settings".*went to "Settings"/],
  ['click', /Notifications.*"Saved" briefly/],
  ['click', /"Log out".*opened "Log out\?"/],
  ['click', /"Cancel".*closed "Log out\?"/],
];
const w = await watchVideo(process.argv[2] ?? 'walkthrough.mp4', { narration: false });
const got = w.actions.map((a) => [a.kind, describe(a)]);
let ok = 0, k = 0; const misses = [];
for (const [kind, re] of expected) {
  const j = got.findIndex((g, n) => n >= k && g[0] === kind && re.test(g[1]));
  if (j >= 0) { ok++; k = j + 1; } else misses.push(`${kind} ${re}`);
}
const extra = got.length - ok;
console.log(`matched ${ok}/${expected.length}, extra ${extra}${misses.length ? '\n  missed: ' + misses.join('\n  missed: ') : ''}`);
if (extra) for (const g of got) if (!expected.some(([kind, re]) => g[0] === kind && re.test(g[1]))) console.log('  extra:', g[1]);
await w.cleanup();
