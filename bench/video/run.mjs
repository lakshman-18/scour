const { watchVideo, describe } = await import('../../dist/video/watch.js');
const { fmt } = await import('../../dist/video/media.js');
const w = await watchVideo(process.argv[2], { narration: process.argv[3] === 'n' });
console.log('pointer seen:', w.pointerSeen, '| screens:', w.screens.map(s => s.id + ':' + s.title + (s.visits>1?' x'+s.visits:'')).join(' | '));
for (const a of w.actions) console.log(String(a.n).padStart(2), fmt(a.t), a.kind.padEnd(5), a.evidence.padEnd(8), describe(a), a.responseSec!==undefined ? '(' + a.responseSec.toFixed(1) + 's)' : '', a.loadingSec ? '[loading ' + a.loadingSec.toFixed(1) + 's]' : '', a.said ? ' said: ' + a.said : '');
await w.cleanup();