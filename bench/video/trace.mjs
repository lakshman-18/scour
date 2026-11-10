const { watchVideo } = await import(new URL('../../dist/video/watch.js', import.meta.url).pathname);
const w = await watchVideo(process.argv[2] ?? 'walkthrough.mp4', { narration: false, debug: true });
console.log(w.notes?.join('\n'));
for (const t of w.trace ?? []) console.log(JSON.stringify(t));
await w.cleanup();
