const { watchVideo } = await import(new URL('../../dist/video/watch.js', import.meta.url).pathname);
const w = await watchVideo(process.argv[2], { narration: false });
for (const [i, st] of w.states.entries()) {
  console.log(`#${i} t=${st.t.toFixed(2)} screen=${st.screen} title=${JSON.stringify(st.title)}${st.overlay ? ' overlay=' + JSON.stringify(st.overlay) : ''}`);
  for (const e of st.els) console.log(`   ${e.kind.padEnd(6)} ${JSON.stringify(e.text).padEnd(40)} @${[e.box.x, e.box.y, e.box.w, e.box.h].map(Math.round).join(',')}`);
}
await w.cleanup();
