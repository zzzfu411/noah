const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { join } = require('node:path');

class Backend extends EventEmitter {
  constructor({ root, dataDir, execPath = process.execPath, env = process.env, runAsNode = true, timeoutMs = 25000 }) {
    super();
    this.options = { root, dataDir, execPath, env, runAsNode, timeoutMs };
    this.child = undefined;
    this.connection = undefined;
    this.stopping = false;
    this.stopPromise = undefined;
  }
  async start() {
    if (this.child) throw new Error('Noah backend is already starting or running');
    const o = this.options;
    const env = { ...o.env, NOAH_DATA_DIR: o.dataDir };
    delete env.NODE_OPTIONS;
    if (o.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;
    const child = fork(join(o.root, 'desktop/service.ts'), [], {
      execPath: o.execPath, execArgv: [], cwd: o.root, env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: process.platform !== 'win32',
    });
    this.child = child;
    let errorTail = '';
    child.stderr.on('data', chunk => {
      errorTail = (errorTail + chunk.toString().replace(/\b(?:sk-|xai-)[A-Za-z0-9_-]{12,}/g, '[redacted]')).slice(-2000);
    });
    child.on('exit', (code, signal) => {
      if (!this.stopping && this.connection) {
        // The service owns a separate process group. A crash must not leave its
        // managed harnesses generating after the desktop reports it stopped.
        void this.stop().then(() => this.emit('lost', new Error(`后台进程已退出（${code ?? signal}）。重新打开应用可恢复已保存的任务。`)));
      }
    });
    try {
      this.connection = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Noah 后台启动超时。')), o.timeoutMs);
        const fail = error => { clearTimeout(timer); reject(error); };
        child.once('error', fail);
        child.once('exit', (code, signal) => fail(new Error(`Noah 后台未能启动（${code ?? signal}）。${errorTail}`)));
        child.on('message', message => {
          if (message?.type === 'startup-error') fail(new Error(message.error));
          if (message?.type !== 'ready') return;
          try {
            const url = new URL(message.url);
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('Invalid desktop service handshake');
            clearTimeout(timer); resolve({ url: url.origin, token: message.token, pid: child.pid });
          } catch (error) { fail(error); }
        });
      });
      return this.connection;
    } catch (error) { await this.stop(); throw error; }
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const child = this.child;
    if (!child?.pid) return this.stopPromise = Promise.resolve();
    const killGroup = signal => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
      } catch { return false; }
    };
    this.stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
        const finish = () => { clearTimeout(force); clearTimeout(hard); resolve(); };
        const force = setTimeout(() => killGroup('SIGTERM'), 10000);
        const hard = setTimeout(() => { killGroup('SIGKILL'); finish(); }, 12000);
        child.once('exit', finish);
        if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) killGroup('SIGTERM'); });
        else killGroup('SIGTERM');
      });
      // A group may still exist after its leader exits. Only this desktop's
      // detached group is addressed; external native sessions are never in it.
      if (process.platform !== 'win32' && killGroup('SIGTERM')) {
        await new Promise(resolve => setTimeout(resolve, 500));
        killGroup('SIGKILL');
      }
    })();
    return this.stopPromise;
  }
}
module.exports = { Backend };
