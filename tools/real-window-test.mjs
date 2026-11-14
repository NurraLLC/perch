// End-to-end check of the helper on a real Chrome popup window (throwaway profile):
// attach and crop, opacity, clicks reaching the page, Ghost click-through, and release.
// Usage: node tools/real-window-test.mjs <helper.exe> <screenshot-dir>
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [, , helperExe, shotDir] = process.argv;
const dir = mkdtempSync(join(tmpdir(), 'perch-e2e-'));
writeFileSync(join(dir, 'p2.html'), `<!doctype html><body style="margin:0;background:#111;height:100vh;box-sizing:border-box;border:6px solid #ff2d55;font:22px Segoe UI;color:#fff;display:grid;place-items:center">
<div id=m>Perch float test</div><script>let c=0;const t=()=>document.title='perch-t1 '+innerWidth+' '+innerHeight+' '+devicePixelRatio+' clicks='+c;t();
addEventListener('resize',t);addEventListener('pointerdown',()=>{c++;m.textContent='clicked '+c;t()})</script></body>`);
writeFileSync(join(dir, 'p.html'), `<title>opener</title><script>window.open('p2.html','perchpop','popup,width=600,height=400,left=300,top=300')</script>`);

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
spawn(chrome, [`--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', '--window-position=1200,100', '--window-size=500,300', `file:///${join(dir, 'p.html').replace(/\\/g, '/')}`], { stdio: 'ignore', detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd]).toString().trim();
const findTitle = `Add-Type -Name E -Namespace Q -MemberDefinition '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l); public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder sb, int m); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder sb, int m); [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);'; $out=''; $cb={ param($h,$l) $sb=New-Object System.Text.StringBuilder 512; [void][Q.E]::GetWindowTextW($h,$sb,512); if ($sb.ToString() -like 'perch-t1*') { $script:out=$sb.ToString() }; [void][Q.E]::EnumChildWindows($h,$cb,[IntPtr]::Zero); $true }; [void][Q.E]::EnumWindows($cb,[IntPtr]::Zero); $out`;
const title = () => ps(findTitle);
const shot = (name, x, y, w, h) => ps(`Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap ${w},${h}; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x},${y},0,0,(New-Object System.Drawing.Size ${w},${h})); $b.Save('${join(shotDir, name)}')`);
const click = (x, y) => ps(`Add-Type -Name M -Namespace K -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,uint d,IntPtr e); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);'; [void][K.M]::SetProcessDpiAwarenessContext([IntPtr](-4)); [void][K.M]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 120; [K.M]::mouse_event(2,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 50; [K.M]::mouse_event(4,0,0,0,[IntPtr]::Zero)`);

let t = '';
for (let i = 0; i < 40 && !t; i++) { await sleep(400); t = title(); }
if (!t) { console.log('FAIL: no popup window'); process.exit(1); }
const [, iw, ih, dpr] = t.split(' ');
console.log('popup page:', t);

const helper = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PERCH_DEBUG: '1' } });
let buf = Buffer.alloc(0);
const msgs = [];
helper.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readInt32LE(0);
    if (buf.length < 4 + n) break;
    const m = JSON.parse(buf.subarray(4, 4 + n).toString());
    msgs.push(m);
    console.log('helper:', JSON.stringify(m));
    buf = buf.subarray(4 + n);
  }
});
const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const l = Buffer.alloc(4); l.writeInt32LE(b.length); helper.stdin.write(Buffer.concat([l, b])); };

send({ type: 'attach', id: 1, token: 'perch-t1', iw: +iw, ih: +ih, dpr: +dpr, def: { w: 480, h: 270 } });
await sleep(1500);
const att = msgs.find((m) => m.type === 'attached');
if (!att) { console.log('FAIL: not attached'); process.exit(1); }
const r = att.rect;
const cx = r.x + Math.round(r.w / 2), cy = r.y + Math.round(r.h / 2);
console.log('page after attach:', title());
shot('e2e-1-attached.png', r.x - 40, r.y - 40, r.w + 80, r.h + 80);

click(cx, cy); await sleep(500);
console.log('after click:', title());

send({ type: 'opacity', id: 1, value: 70 }); await sleep(700);
shot('e2e-2-opacity70.png', r.x - 40, r.y - 40, r.w + 80, r.h + 80);

send({ type: 'ghost', id: 1, on: true }); await sleep(700);
click(cx, cy); await sleep(500);
console.log('after ghost click (should be unchanged):', title());
send({ type: 'ghost', id: 1, on: false }); send({ type: 'opacity', id: 1, value: 100 }); await sleep(400);

send({ type: 'resize', id: 1, edge: 'br' }); // no button held: ends immediately, harmless
send({ type: 'fit', id: 1, aspect: 1 }); await sleep(600);
const fitted = msgs.filter((m) => m.type === 'placed').pop();
console.log('fit 1:1 ->', JSON.stringify(fitted && fitted.rect), 'page:', title());

send({ type: 'release', id: 1 }); await sleep(800);
console.log('after release:', title());
shot('e2e-3-released.png', r.x - 160, r.y - 200, r.w + 200, r.h + 260);

helper.stdin.end();
await sleep(300);
ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${dir.split(/[\\/]/).pop()}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
process.exit(0);
