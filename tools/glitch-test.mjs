// Measures Perch's two visual rough edges on the installed or given build:
//  1. pop-out flash: screenshots in a burst right after Alt+P, counting frames where a
//     framed browser popup (not yet cropped) is visible;
//  2. resize dark edge: grows the float with the real mouse and counts frames with a
//     pure-black band at the growing edge.
// Usage: node tools/glitch-test.mjs <out-dir>
// WARNING: drives the real mouse and keyboard and screenshots the whole screen. Don't use
// the PC while it runs, and delete <out-dir> afterwards.
// Runs in a throwaway Chrome profile with the extension loaded over the DevTools pipe.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outDir = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { maxBuffer: 1 << 26 }).toString().trim();

const page = `<!doctype html><meta charset=utf-8><title>Perch glitch test</title>
<body style="margin:0;background:#d8d8d8"><div style="height:140px"></div>
<div id=movie_player style="width:720px;height:405px;margin-left:60px"><video id=v autoplay muted playsinline style="width:100%;height:100%"></video></div>
<script>const c=document.createElement('canvas');c.width=1280;c.height=720;const g=c.getContext('2d');let f=0;
(function d(){f++;g.fillStyle='#2f6f4f';g.fillRect(0,0,1280,720);g.fillStyle='#fff';g.font='bold 100px Segoe UI';g.fillText('Frame '+f,330,400);requestAnimationFrame(d)})();
v.srcObject=c.captureStream(30);</script>`;
const server = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(page); }).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const profile = mkdtempSync(join(tmpdir(), 'perch-glitch-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging', '--start-maximized', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let id = 1; const pend = new Map(); let buf = '';
chrome.stdio[4].on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
const cdp = (method, params = {}, sessionId) => new Promise((res) => { const n = id++; pend.set(n, res); chrome.stdio[3].write(JSON.stringify({ id: n, method, params, sessionId }) + '\0'); });

await sleep(1500);
const loaded = await cdp('Extensions.loadUnpacked', { path: resolve('extension') });
await cdp('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
await sleep(2500);

// 1) Burst-capture the whole screen for ~1.6s right after Alt+P. Each frame is reduced to a
//    tiny thumbnail plus a flag: does any visible top-level Chrome popup window (framed, not
//    inside a Perch host) exist at that moment?
const burst = ps(`
Add-Type -AssemblyName System.Drawing
Add-Type -Name B -Namespace G -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int m);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int m);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
public struct RECT { public int L,T,R,B; }'
[void][G.B]::SetProcessDpiAwarenessContext([IntPtr](-4))
$p = Get-Process chrome | ? { $_.MainWindowTitle -like 'Perch glitch test*' } | select -First 1
$main = $p.MainWindowHandle
[void][G.B]::SetForegroundWindow($main); Start-Sleep -Milliseconds 200; Add-Type -Name C -Namespace Z -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,uint d,IntPtr e);'; [void][Z.C]::SetCursorPos(1500,1000); [Z.C]::mouse_event(2,0,0,0,[IntPtr]::Zero); [Z.C]::mouse_event(4,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 300
$b = New-Object System.Drawing.Rectangle 0,0,2560,1440
[G.B]::keybd_event(0x12,0,0,[IntPtr]::Zero); [G.B]::keybd_event(0x50,0,0,[IntPtr]::Zero); [G.B]::keybd_event(0x50,0,2,[IntPtr]::Zero); [G.B]::keybd_event(0x12,0,2,[IntPtr]::Zero)
$sw = [Diagnostics.Stopwatch]::StartNew(); $n = 0; $flagged = 0
while ($sw.ElapsedMilliseconds -lt 1600) {
  # the test page in a visible, on-screen top-level window other than the main one = the uncropped popup
  $script:found = $false
  $cb = [G.B+EnumProc]{ param($h,$l) if ($h -ne $main -and [G.B]::IsWindowVisible($h)) { $t = New-Object System.Text.StringBuilder 256; [void][G.B]::GetWindowTextW($h,$t,256); if ($t.ToString() -like '*Perch glitch test*') { $r = New-Object G.B+RECT; [void][G.B]::GetWindowRect($h,[ref]$r); if ($r.R -gt 0 -and $r.L -lt 3840) { $script:found = $true } } }; $true }
  [void][G.B]::EnumWindows($cb,[IntPtr]::Zero)
  if ($script:found) { $flagged++ }
  $bmp = New-Object System.Drawing.Bitmap 2560,1440; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0,0,0,0,$b.Size)
  $small = New-Object System.Drawing.Bitmap $bmp, 640, 360; $small.Save((Join-Path '${outDir.replace(/\\/g, '\\\\')}' ('pop-{0:D2}.png' -f $n))); $g.Dispose(); $bmp.Dispose(); $small.Dispose()
  $n++
}
"frames=$n uncroppedPopupFrames=$flagged"`);
console.log('pop-out:', burst.split('\n').pop());

// 2) Grow the float from its bottom-right corner with the real mouse, sampling the right edge.
const { result: { targetInfos } } = await cdp('Target.getTargets');
const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(loaded.result.id));
const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
const fl = JSON.parse((await cdp('Runtime.evaluate', { expression: 'JSON.stringify([...floats.values()][0])', replMode: true, returnByValue: true }, sessionId)).result.result.value);
const tabId = fl.tabId;
const L = fl.rect.x, T = fl.rect.y, R = fl.rect.x + fl.rect.w, B = fl.rect.y + fl.rect.h;
console.log('float rect:', L, T, R, B);
// Move the float to the top-left area first so it has room to grow.
const resize = ps(`
Add-Type -AssemblyName System.Drawing
Add-Type -Name E -Namespace Q -MemberDefinition 'public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int m);'; function HostWnd { $script:hw=[IntPtr]::Zero; $cb=[Q.E+P]{ param($h,$l) $sb=New-Object System.Text.StringBuilder 64; [void][Q.E]::GetClassNameW($h,$sb,64); if ($sb.ToString() -eq 'PerchFloatHost') { $script:hw=$h; return $false }; $true }; [void][Q.E]::EnumWindows($cb,[IntPtr]::Zero); $script:hw };
Add-Type -Name M -Namespace K -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,uint d,IntPtr e); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string t); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L,T,R,B; }'
[void][K.M]::SetProcessDpiAwarenessContext([IntPtr](-4))

$dark = 0; $frames = 0
$x1 = ${L} + 4; $y1 = ${T} + 4
[void][K.M]::SetCursorPos($x1,$y1); [K.M]::mouse_event(2,0,0,0,[IntPtr]::Zero)
"go" | Out-File -Encoding ascii '${outDir.replace(/\\/g, '\\\\')}\\resize-go.flag'
Start-Sleep -Milliseconds 200
for ($i=1; $i -le 24; $i++) {
  [void][K.M]::SetCursorPos($x1 - 40*$i, $y1 - 22*$i)
  Start-Sleep -Milliseconds 12
  $fx = ${L} - 40*$i; $fy = ${T} - 22*$i; $w = ${R} - $fx; $h = ${B} - $fy
  if ($w -lt 20 -or $h -lt 20) { continue }
  $bmp = New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($fx,$fy,0,0,(New-Object System.Drawing.Size $w,$h))
  # pure black pixels in a 24px band along the growing left edge (test page has no pure black)
  $black = 0; $total = 0
  for ($yy = 60; $yy -lt $h - 30; $yy += 6) { for ($xx = 4; $xx -lt 28; $xx += 4) { $c = $bmp.GetPixel($xx,$yy); $total++; if ($c.R -lt 6 -and $c.G -lt 6 -and $c.B -lt 6) { $black++ } } }
  if ($total -gt 0 -and ($black / $total) -gt 0.3) { $dark++ }
  $frames++; $g.Dispose(); $bmp.Dispose()
}
[K.M]::mouse_event(4,0,0,0,[IntPtr]::Zero)
"frames=$frames darkEdgeFrames=$dark"`);
await sleep(100);
console.log('resize (growing from the top-left corner):', resize.split('\n').pop());
await cdp('Runtime.evaluate', { expression: `back(${tabId})`, awaitPromise: true, replMode: true }, sessionId);
await sleep(600);
try { await cdp('Browser.close'); } catch {}
server.close();
setTimeout(() => process.exit(0), 600);
