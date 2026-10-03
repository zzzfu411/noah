import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
const dataDir = resolve(process.env.NOAH_DATA_DIR || '.noah');
try {
  const { url, token } = JSON.parse(readFileSync(join(dataDir, 'connection.json'), 'utf8'));
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [`${url}/#token=${token}`], { stdio: 'ignore' });
  child.on('error', () => { console.error('无法打开浏览器；请检查系统默认浏览器。'); process.exitCode = 1; });
} catch { console.error('请先在 Noah 目录运行 npm start。'); process.exitCode = 1; }
