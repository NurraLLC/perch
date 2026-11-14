// Drives a real mouse drag and edge-resize through the helper on a throwaway Chrome popup.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [, , helperExe] = process.argv;
const dir = mkdtempSync(join(tmpdir(), 'perch-drag-'));
writeFileSync(join(dir, 'p2.html'), `<body style="margin:0;background:#123;height:100vh"><script>document.title='perch-d1 '+innerWidth+' '+innerHeight+' '+devicePixelRatio</script>`);
writeFileSync(join(dir, 'p.html'), `<script>window.open('p2.html','x','popup,width=600,height=400,left=300,top=300')</script>`);
spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [`--user-data-dir=${join(dir, 'prof')}`, '--no-first-run', '--disable-popup-blocking', `file:///${join(dir, 'p.html').split(String.fromCharCode(92)).join('/')}`], { stdio: 'ignore', detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (c) => execFileSync('powershell', ['-NoProfile', '-Command', c]).toString().trim();
const M = `Add-Type -Name M -Namespace K -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,uint d,IntPtr e); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);'; [void][K.M]::SetProcessDpiAwarenessContext([IntPtr](-4));`;
let t = '';
for (let i = 0; i < 40 && !t; i++) { await sleep(400); t = ps(`(Get-Process chrome | ? { $_.MainWindowTitle -like 'perch-d1*' } | select -First 1).MainWindowTitle`); }
const [, iw, ih, dpr] = t.split(' ');
const h = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0); const msgs = [];
h.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readInt32LE(0); if (buf.length < 4 + n) break; msgs.push(JSON.parse(buf.subarray(4, 4 + n).toString())); buf = buf.subarray(4 + n); } });
const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const l = Buffer.alloc(4); l.writeInt32LE(b.length); h.stdin.write(Buffer.concat([l, b])); };
send({ type: 'attach', id: 1, token: 'perch-d1', iw: +iw, ih: +ih, dpr: +dpr, def: { w: 480, h: 270 } });
await sleep(1500);
const r = msgs.find((m) => m.type === 'attached').rect;
console.log('start   ', JSON.stringify(r));
// drag: press at the top bar, move up-left 600,400, release
const x0 = r.x + 100, y0 = r.y + 15;
ps(`${M} [void][K.M]::SetCursorPos(${x0},${y0}); [K.M]::mouse_event(2,0,0,0,[IntPtr]::Zero)`);
send({ type: 'drag', id: 1 }); await sleep(150);
for (let i = 1; i <= 10; i++) { ps(`${M} [void][K.M]::SetCursorPos(${x0 - 60 * i},${y0 - 40 * i})`); }
ps(`${M} [K.M]::mouse_event(4,0,0,0,[IntPtr]::Zero)`); await sleep(400);
const moved = msgs.filter((m) => m.type === 'placed').pop();
console.log('dragged ', JSON.stringify(moved && moved.rect));
// resize from the bottom-right corner by +300,+150
const m = moved.rect; const x1 = m.x + m.w - 3, y1 = m.y + m.h - 3;
ps(`${M} [void][K.M]::SetCursorPos(${x1},${y1}); [K.M]::mouse_event(2,0,0,0,[IntPtr]::Zero)`);
send({ type: 'resize', id: 1, edge: 'br' }); await sleep(150);
for (let i = 1; i <= 10; i++) { ps(`${M} [void][K.M]::SetCursorPos(${x1 + 30 * i},${y1 + 15 * i})`); }
ps(`${M} [K.M]::mouse_event(4,0,0,0,[IntPtr]::Zero)`); await sleep(500);
const sized = msgs.filter((x) => x.type === 'placed').pop();
console.log('resized ', JSON.stringify(sized && sized.rect));
console.log('page now', ps(`(Get-Process chrome | ? { $_.MainWindowTitle -like 'perch-d1*' } | select -First 1).MainWindowTitle`) || '(child window; see rect)');
send({ type: 'release', id: 1 }); await sleep(500); h.stdin.end();
ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ? { $_.CommandLine -like '*${dir.split(String.fromCharCode(92)).pop()}*' } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
process.exit(0);
