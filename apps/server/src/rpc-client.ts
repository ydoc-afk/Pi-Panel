import { StringDecoder } from 'node:string_decoder';
import type { RunningProcess } from './runtime.js';

export type PiEvent = { type: string } & Record<string, unknown>;

export interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

const MAX_LINE = 16 * 1024 * 1024;

/**
 * Splits a byte stream into JSONL records on LF only. Node's `readline` is deliberately not used:
 * it also splits on U+2028/U+2029, which are valid inside JSON strings.
 */
export class LineFramer {
  private decoder = new StringDecoder('utf8');
  private buf = '';

  push(chunk: string | Buffer): string[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) lines.push(line);
    }
    if (this.buf.length > MAX_LINE) throw new Error('Record exceeds maximum line length');
    return lines;
  }
}

interface Pending {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Client for `pi --mode rpc`: correlates responses by id and forwards session events. */
export class RpcClient {
  private framer = new LineFramer();
  private pending = new Map<string, Pending>();
  private eventCbs: ((e: PiEvent) => void)[] = [];
  private closeCbs: ((code: number | null, stderrTail: string) => void)[] = [];
  private stderrTail = '';
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly proc: RunningProcess,
    private readonly timeoutMs = 30_000,
  ) {
    proc.onStdout((chunk) => this.onStdout(chunk));
    proc.onStderr((chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    proc.onExit((code) => this.onExit(code));
  }

  onEvent(cb: (e: PiEvent) => void) {
    this.eventCbs.push(cb);
  }

  onClose(cb: (code: number | null, stderrTail: string) => void) {
    this.closeCbs.push(cb);
  }

  request(command: { type: string } & Record<string, unknown>): Promise<RpcResponse> {
    if (this.closed) return Promise.reject(new Error('pi process has exited'));
    const id = `r${this.nextId++}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${command.type} response`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }

  /** Terminates the process; pending requests are rejected via the exit handler. */
  close() {
    this.proc.kill();
  }

  private onStdout(chunk: string | Buffer) {
    let lines: string[];
    try {
      lines = this.framer.push(chunk);
    } catch {
      this.proc.kill();
      return;
    }
    for (const line of lines) {
      let record: PiEvent;
      try {
        record = JSON.parse(line) as PiEvent;
      } catch {
        continue; // stdout is reserved for protocol records; ignore stray text
      }
      if (record.type === 'response') {
        const res = record as unknown as RpcResponse;
        const p = res.id ? this.pending.get(res.id) : undefined;
        if (p && res.id) {
          clearTimeout(p.timer);
          this.pending.delete(res.id);
          p.resolve(res);
        }
      } else {
        for (const cb of this.eventCbs) cb(record);
      }
    }
  }

  private onExit(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('pi process exited'));
    }
    this.pending.clear();
    for (const cb of this.closeCbs) cb(code, this.stderrTail);
  }
}
