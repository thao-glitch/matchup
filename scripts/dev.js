/**
 * Run the signaling server and the Vite dev server together with prefixed,
 * interleaved output. No dependency needed (`concurrently` would do the same).
 *
 *   npm run dev
 */
const { spawn } = require('child_process');
const path = require('path');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const targets = [
  { name: 'server', dir: path.join(__dirname, '..', 'server'), args: ['run', 'dev'] },
  { name: 'client', dir: path.join(__dirname, '..', 'client'), args: ['run', 'dev'] },
];

const children = [];

for (const target of targets) {
  const child = spawn(npm, target.args, {
    cwd: target.dir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  children.push(child);

  const attach = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) console.log(`[${target.name}] ${line}`);
    });
    stream.on('end', () => {
      if (buffer) console.log(`[${target.name}] ${buffer}`);
    });
  };

  attach(child.stdout);
  attach(child.stderr);

  child.on('exit', (code, signal) => {
    console.log(`[${target.name}] exited (${signal || code})`);
  });
}

console.log('\n  server → http://localhost:4000   (API + signaling)');
console.log('  client → http://localhost:5173   (open this in two tabs)\n');

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, stopping dev servers…`);
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
