import { readFileSync } from 'node:fs';
const S = new URL('../../dist/video/', import.meta.url).pathname;
const { greyFrames, analyse, trackPointer, pointerAt, flickerMap, refinePointer } = await import(S + 'signal.js');
const { movingOnly } = await import(S + 'watch.js');
const truth = JSON.parse(readFileSync('truth.json', 'utf8')).filter((e) => e.what.startsWith('click'));
const { grid, frames } = await greyFrames('walkthrough.mp4', 10, 1280, 720);
const steps = analyse(frames, grid);
const flicker = flickerMap(steps, grid);
const mov = movingOnly(trackPointer(steps, grid, flicker), 80);
let ok1 = 0, ok2 = 0;
for (const c of truth) {
  const p = pointerAt(mov, c.t + 0.15, 600);
  // start of the run of motion that ended at p, and where the pointer rested before it
  let k = mov.indexOf(p); while (k > 0 && mov[k].t - mov[k - 1].t <= 0.35) k--;
  const from = k > 0 ? mov[k - 1] : undefined;
  const fine = p ? await refinePointer('walkthrough.mp4', 1280, 720, from && { t: mov[k].t - 0.1, x: from.x, y: from.y }, p) : undefined;
  const d1 = p ? Math.hypot(p.x - c.x, p.y - c.y) : Infinity, d2 = fine ? Math.hypot(fine.x - c.x, fine.y - c.y) : d1;
  if (d1 < 40) ok1++; if (d2 < 40) ok2++;
  console.log(c.what.replace('click ', '').padEnd(26), 'truth', (c.x + ',' + c.y).padEnd(9), 'coarse', p ? Math.round(p.x) + ',' + Math.round(p.y) : '-', 'err', String(Math.round(d1)).padEnd(4), 'fine', fine ? Math.round(fine.x) + ',' + Math.round(fine.y) : '-', 'err', Math.round(d2));
}
console.log(`within 40px: coarse ${ok1}/${truth.length}, refined ${ok2}/${truth.length}`);