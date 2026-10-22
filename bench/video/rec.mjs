// Records a fake app being used (app.html) with Playwright, logging every real click to truth.json.
// The watcher is then scored against it: node score.mjs walkthrough.mp4
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: '.', size: { width: 1280, height: 720 } } });
const p = await ctx.newPage();
const t0 = Date.now(); const truth = []; const log = (what, b) => truth.push({ t: +((Date.now() - t0) / 1000).toFixed(2), what, x: b ? Math.round(b.x + b.width / 2) : undefined, y: b ? Math.round(b.y + b.height / 2) : undefined });
await p.goto('file://' + process.cwd() + '/app.html');
const moveClick = async (sel, wait = 1500) => { const b = await p.locator(sel).first().boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2; await p.mouse.move(x, y, { steps: 18 }); await p.waitForTimeout(250); log('click ' + sel, b); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(wait); };
await p.mouse.move(640, 400); await p.waitForTimeout(1800);
await moveClick('#intro1 >> text=Next');
await moveClick('#intro2 >> text=Next');
await moveClick('#email', 400); log('type email'); await p.keyboard.type('ana@example.com', { delay: 70 });
await moveClick('#pw', 400); await p.keyboard.type('abc', { delay: 90 });
await moveClick('#signupBtn', 1600);
await moveClick('#pw', 400); await p.keyboard.type('defgh12', { delay: 80 });
await moveClick('#signupBtn', 2600);
await p.mouse.move(640, 500, { steps: 10 }); log('scroll'); await p.mouse.wheel(0, 500); await p.waitForTimeout(900); await p.mouse.wheel(0, 500); await p.waitForTimeout(1500);
await moveClick('#navSettings', 1600);
await moveClick('#tg', 2200);
await moveClick('#logout', 1800);
await moveClick('#cancelOut', 1800);
const v = p.video(); await ctx.close(); await browser.close();
const webm = await v.path();
const fs = await import('node:fs');
fs.writeFileSync('truth.json', JSON.stringify(truth, null, 1));
(await import('node:child_process')).execFileSync('ffmpeg', ['-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-y', 'walkthrough.mp4']);
fs.rmSync(webm);
console.log('recorded walkthrough.mp4 and truth.json');