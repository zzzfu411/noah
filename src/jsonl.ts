import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { redact } from './config.ts';

export class JsonLines {
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  feed(chunk: Buffer | string): any[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) throw new Error('Protocol frame exceeds 8 MiB');
    const frames = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
    return frames;
  }
}

export class JsonRpcProcess extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  private counter = 0;
  private pending = new Map<number, { resolve: (x: any) => void; reject: (x: Error) => void; timer: NodeJS.Timeout }>();
  private parser = new JsonLines();
  private closed = false;
  private stderrTail = '';
  handleRequest?: (method: string, params: any) => Promise<any>;
  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', data => {
      try { for (const message of this.parser.feed(data)) void this.receive(message); }
      catch { this.fail(new Error('Harness returned malformed JSONL')); this.child.kill(); }
    });
    this.child.stderr.on('data', data => { this.stderrTail = (this.stderrTail + redact(data.toString())).slice(-3000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => { this.closed = true; this.fail(error); });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Harness exited (${code ?? signal}). ${this.stderrTail}`));
      this.emit('exit', { code, signal });
    });
  }
  private async receive(message: any) {
    if (message.method && message.id !== undefined) {
      try {
        if (!this.handleRequest) throw new Error('Client method unsupported');
        const result = await this.handleRequest(message.method, message.params);
        this.send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) { this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: redact(error) } }); }
    } else if (message.method) this.emit('notification', message.method, message.params);
    else if (message.id !== undefined) {
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.error) item.reject(new Error(redact(message.error.message || 'Harness request failed')));
      else item.resolve(message.result);
    }
  }
  send(message: unknown) {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown = {}, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Harness is disconnected'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Harness timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method: string, params: unknown = {}) { this.send({ jsonrpc: '2.0', method, params }); }
  private fail(error: Error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(redact(error))); }
    this.pending.clear();
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end(); this.child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
