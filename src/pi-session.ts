import { closeSync, fsyncSync, openSync, readFileSync, statSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { privateDir } from './config.ts';

export function openPiSession(options: {
  cwd: string; sessionDir: string; sessionFile?: string; expectedSessionId?: string;
}): SessionManager {
  const { cwd, sessionDir, sessionFile, expectedSessionId } = options;
  if (sessionFile || expectedSessionId) {
    if (!sessionFile || !expectedSessionId) throw new Error('Pi 会话恢复缺少原生 ID 或文件绑定；已停止，未创建替代会话。');
    let header: any;
    try {
      const stat = statSync(sessionFile);
      if (!stat.isFile() || stat.size === 0) throw new Error('Empty session');
      header = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n', 1)[0]);
    } catch {
      throw new Error('Pi 会话文件缺失、为空或损坏；无法恢复，未创建替代会话。');
    }
    if (header?.type !== 'session' || header.id !== expectedSessionId) {
      throw new Error('Pi 会话文件的原生 ID 与 Noah 绑定不符；已停止恢复。');
    }
    const manager = SessionManager.open(sessionFile, sessionDir, cwd);
    if (manager.getSessionId() !== expectedSessionId || manager.getHeader()?.id !== expectedSessionId) {
      throw new Error('Pi 恢复后的原生 ID 与 Noah 绑定不符；已停止恢复。');
    }
    return manager;
  }

  const manager = SessionManager.create(cwd, privateDir(sessionDir));
  const file = manager.getSessionFile();
  if (!file) throw new Error('Pi 未提供持久会话文件。');
  // The SDK normally defers its first write until an assistant responds. Its
  // public empty-file initialization path persists a header without inventing
  // a model message. Initialize before exposing the final ID to Noah so a
  // restart before the first prompt can restore the same native session.
  closeSync(openSync(file, 'wx', 0o600));
  manager.setSessionFile(file);
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return manager;
}
