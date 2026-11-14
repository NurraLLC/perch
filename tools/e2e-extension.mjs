// Full extension run in a throwaway Chrome profile: load Perch over the DevTools pipe,
// open a page with a playing video, press Alt+P, check the float, then bring it back.
// Usage: node tools/e2e-extension.mjs <screenshot-dir>
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const shotDir = process.argv[2];
const extPath = resolve('extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd]).toString().trim();
const shot = (name, x, y, w, h) => ps(`Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap ${w},${h}; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x},${y},0,0,(New-Object System.Drawing.Size ${w},${h})); $b.Save('${join(shotDir, name)}')`);

const page = `<!doctype html><title>Perch E2E</title><body style="margin:0;background:#202124;color:#eee;font:16px Segoe UI">
<header style="height:120px;padding:20px">Some site header, nav, comments…</header>
<div id="movie_player" style="width:640px;height:360px;margin-left:40px;background:#000;position:relative;transform:translateZ(0)">
<video id="v" autoplay muted playsinline style="width:100%;height:100%"></video>
<div style="position:absolute;bottom:8px;left:12px;color:#fff;font:13px Segoe UI">site controls</div></div>
<p style="padding:20px">More page content below the player.</p>
<script>
const c=document.createElement('canvas');c.width=1280;c.height=720;const g=c.getContext('2d');let f=0;
(function draw(){f++;g.fillStyle='hsl('+(f%360)+',60%,35%)';g.fillRect(0,0,1280,720);g.fillStyle='#fff';g.font='bold 120px Segoe UI';g.fillText('Frame '+f,330,400);g.strokeStyle='#FFB547';g.lineWidth=16;g.strokeRect(8,8,1264,704);requestAnimationFrame(draw)})();
v.srcObject=c.captureStream(30);
</script>`;
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); }).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'perch-ext-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging', '--window-position=80,80', '--window-size=1100,820', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

// ---- minimal CDP over the pipe
let nextId = 1;
const pending = new Map();
let inbuf = '';
chrome.stdio[4].on('data', (d) => {
  inbuf += d.toString();
  let i;
  while ((i = inbuf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(inbuf.slice(0, i));
    inbuf = inbuf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
});

const done = async (code) => {
  try { await cdp('Browser.close'); } catch {}
  server.close();
  setTimeout(() => process.exit(code), 800);
};

await sleep(1500);
const loaded = await cdp('Extensions.loadUnpacked', { path: extPath });
console.log('loadUnpacked:', JSON.stringify(loaded.result || loaded.error));
if (!loaded.result) { await done(1); await sleep(5000); }

await cdp('Target.createTarget', { url: process.argv[3] || url });
await sleep(process.argv[3] ? 7000 : 2500);

// Focus the page window and press Alt+P (the extension's command; also grants activeTab).
ps(`Add-Type -Name K -Namespace F -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);'; $p = Get-Process chrome | ? { $_.MainWindowTitle -like '${process.argv[4] || 'Perch E2E'}*' } | select -First 1; [void][F.K]::SetForegroundWindow($p.MainWindowHandle); Start-Sleep -Milliseconds 400; [F.K]::keybd_event(0x12,0,0,[IntPtr]::Zero); [F.K]::keybd_event(0x50,0,0,[IntPtr]::Zero); [F.K]::keybd_event(0x50,0,2,[IntPtr]::Zero); [F.K]::keybd_event(0x12,0,2,[IntPtr]::Zero)`);
await sleep(3500);

// Inspect the service worker's state.
const { result: { targetInfos } } = await cdp('Target.getTargets');
const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(loaded.result.id));
const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
const evalSW = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, replMode: true, returnByValue: true }, sessionId);
  return r.result && r.result.result ? r.result.result.value : JSON.stringify(r);
};
const state = await evalSW('JSON.stringify({ helper, floats: [...floats.values()] })');
console.log('after Alt+P:', state);
const s = JSON.parse(state);
if (!s.floats.length) { console.log('FAIL: nothing floated'); { await done(1); await sleep(5000); } }
shot('ext-1-float.png', 1700, 800, 860, 600);
ps(`Add-Type -Name C -Namespace H -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);'; [void][H.C]::SetProcessDpiAwarenessContext([IntPtr](-4)); [void][H.C]::SetCursorPos(2300,1150); Start-Sleep -Milliseconds 150; [void][H.C]::SetCursorPos(2250,1088)`);
await sleep(600);
shot('ext-1b-strip.png', 1960, 1040, 600, 360);

// Fill check: page inside the float should show only the player.
const tabId = s.floats[0].tabId;
const fill = await evalSW(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => ({ on: document.documentElement.hasAttribute('data-perch-on'), filled: !!document.querySelector('[data-perch-fill]'), strip: !!document.getElementById('perch-ui'), title: document.title, iw: innerWidth, ih: innerHeight }) }).then(r => JSON.stringify(r[0].result))`);
console.log('page in float:', fill);

// Ghost + opacity through the same command path the strip uses.
await evalSW(`command(${tabId}, { cmd: 'opacity' })`);
await sleep(500);
shot('ext-2-opacity.png', 1700, 800, 860, 600);
await evalSW(`command(${tabId}, { cmd: 'opacity' }); command(${tabId}, { cmd: 'opacity' }); command(${tabId}, { cmd: 'opacity' })`);

await evalSW(`back(${tabId})`);
await sleep(1500);
const after = await evalSW(`chrome.tabs.get(${tabId}).then(t => chrome.windows.get(t.windowId).then(w => JSON.stringify({ windowType: w.type, index: t.index, active: t.active, floats: floats.size })))`);
console.log('after back:', after);
const exitCheck = await evalSW(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => ({ on: document.documentElement.hasAttribute('data-perch-on'), strip: !!document.getElementById('perch-ui'), playing: !document.getElementById('v').paused }) }).then(r => JSON.stringify(r[0].result))`);
console.log('page after back:', exitCheck);
shot('ext-3-back.png', 60, 60, 1160, 860);
await done(0);
