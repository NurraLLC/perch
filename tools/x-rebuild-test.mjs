// Reproduces X's behaviour: a feed that rebuilds itself whenever the window crosses a width
// breakpoint, with the video inside a quoted post. Floats it with Alt+P in a throwaway
// profile and checks the float still shows that video.
// Usage: node tools/x-rebuild-test.mjs <screenshot-dir> [--no-freeze]
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const shotDir = process.argv[2];
const noFreeze = process.argv.includes('--no-freeze');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd]).toString().trim();
const shot = (name, x, y, w, h) => ps(`Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap ${w},${h}; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x},${y},0,0,(New-Object System.Drawing.Size ${w},${h})); $b.Save('${join(shotDir, name)}')`);

// Optionally run a copy of the extension with the X layout freeze switched off, to prove the test reproduces the bug.
let extPath = resolve('extension');
if (noFreeze) {
  extPath = mkdtempSync(join(tmpdir(), 'perch-ext-nofreeze-'));
  cpSync(resolve('extension'), extPath, { recursive: true });
  const f = join(extPath, 'content.js');
  writeFileSync(f, readFileSync(f, 'utf8').replace('freezeLayout: true', 'freezeLayout: false'));
}

const page = `<!doctype html><meta charset=utf-8><title>X feed test</title>
<body style="margin:0;background:#000;color:#e7e9ea;font:15px Segoe UI"><div id=root></div><script>
let layout = null, rebuilds = 0;
function post(i, quoted) {
  const a = document.createElement('article');
  a.style.cssText = 'border-bottom:1px solid #333;padding:16px';
  const link = document.createElement('a'); link.href = '/user' + i + '/status/' + (1000 + i); link.textContent = 'Post ' + i; link.style.color = '#1d9bf0';
  a.append(link);
  if (quoted) {
    const q = document.createElement('div'); q.style.cssText = 'border:1px solid #444;border-radius:16px;margin-top:10px;padding:10px';
    q.append('Quoted post with a video');
    const vp = document.createElement('div'); vp.setAttribute('data-testid', 'videoPlayer'); vp.style.cssText = 'margin-top:8px;aspect-ratio:16/9;width:100%;background:#111;border-radius:12px;overflow:hidden';
    const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.style.cssText = 'width:100%;height:100%';
    v.srcObject = window.__stream; vp.append(v); q.append(vp); a.append(q);
  } else {
    const p = document.createElement('p'); p.textContent = 'Just some text in the feed.'; a.append(p);
  }
  return a;
}
function render() {
  const w = document.documentElement.clientWidth;
  const l = w < 900 ? 'narrow' : 'wide';
  if (l === layout) return;
  layout = l; rebuilds++;
  root.replaceChildren(post(1), post(2, true), post(3), post(4));
  root.style.cssText = l === 'wide' ? 'width:600px;margin-left:120px' : 'width:auto';
  window.scrollTo(0, 0);
  document.title = 'X feed test rebuilds=' + rebuilds;
}
const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let f = 0;
(function draw() { f++; g.fillStyle = '#1d3b5c'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = 'bold 110px Segoe UI'; g.fillText('Quoted video ' + f, 120, 400); requestAnimationFrame(draw); })();
window.__stream = c.captureStream(30);
addEventListener('resize', render); render();
</script>`;
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); }).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://x.com.localhost:${server.address().port}/home`;

const profile = mkdtempSync(join(tmpdir(), 'perch-x-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging', '--window-position=80,80', '--window-size=1200,860', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let nextId = 1; const pending = new Map(); let inbuf = '';
chrome.stdio[4].on('data', (d) => {
  inbuf += d.toString(); let i;
  while ((i = inbuf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(inbuf.slice(0, i)); inbuf = inbuf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((res) => { const id = nextId++; pending.set(id, res); chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0'); });
const finish = async (code) => { try { await cdp('Browser.close'); } catch {} server.close(); setTimeout(() => process.exit(code), 800); };

await sleep(1500);
const loaded = await cdp('Extensions.loadUnpacked', { path: extPath });
if (!loaded.result) { console.log('load failed', JSON.stringify(loaded)); await finish(1); }
await cdp('Target.createTarget', { url });
await sleep(2500);

const pageEval = async (expr) => {
  const { result: { targetInfos } } = await cdp('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'page' && x.url.includes('x.com.localhost'));
  const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  return r.result.result.value;
};
console.log('before float:', await pageEval(`document.title`));

ps(`Add-Type -Name K -Namespace F -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);'; $p = Get-Process chrome | ? { $_.MainWindowTitle -like 'X feed test*' } | select -First 1; [void][F.K]::SetForegroundWindow($p.MainWindowHandle); Start-Sleep -Milliseconds 400; [F.K]::keybd_event(0x12,0,0,[IntPtr]::Zero); [F.K]::keybd_event(0x50,0,0,[IntPtr]::Zero); [F.K]::keybd_event(0x50,0,2,[IntPtr]::Zero); [F.K]::keybd_event(0x12,0,2,[IntPtr]::Zero)`);
await sleep(4000);

const status = await pageEval(`JSON.stringify({ title: document.title, filled: !!document.querySelector('[data-perch-fill]'), videoFilled: !!document.querySelector('[data-perch-fill] video, video[data-perch-video]'), floatedVideoConnected: !!document.querySelector('video[data-perch-video]') })`);
console.log(noFreeze ? 'float WITHOUT freeze:' : 'float with freeze:', status);
shot(noFreeze ? 'x-nofreeze.png' : 'x-freeze.png', 1700, 760, 860, 640);
await finish(0);
