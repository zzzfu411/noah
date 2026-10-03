import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(electron as unknown as string, [root, ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
