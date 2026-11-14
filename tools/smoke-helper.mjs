// Talks to the built helper over the native-messaging protocol and checks it answers.
import { spawn } from 'node:child_process';

const exe = process.argv[2];
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
const got = [];

child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readInt32LE(0);
    if (buf.length < 4 + n) break;
    got.push(JSON.parse(buf.subarray(4, 4 + n).toString('utf8')));
    buf = buf.subarray(4 + n);
  }
});

const send = (o) => {
  const b = Buffer.from(JSON.stringify(o));
  const len = Buffer.alloc(4); len.writeInt32LE(b.length);
  child.stdin.write(Buffer.concat([len, b]));
};

send({ type: 'ping' });
send({ type: 'attach', id: 7, token: 'perch-nosuchwindow', iw: 800, ih: 450, dpr: 1, def: { w: 480, h: 270 } });
setTimeout(() => {
  child.stdin.end();
  setTimeout(() => {
    console.log(JSON.stringify(got));
    const types = got.map((m) => m.type);
    const ok = types.includes('ready') && types.includes('pong') && types.includes('attachFailed');
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
    process.exit(ok ? 0 : 1);
  }, 600);
}, 6800);
