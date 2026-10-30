import type { RunningProcess } from './runtime.js';

export interface FakePiOptions {
  /** Split stdout writes into chunks of this many bytes, to exercise record framing. */
  chunkSize?: number;
}

type Cb<T> = (value: T) => void;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Scripted stand-in for `pi --mode rpc`: speaks the JSONL protocol (get_state, prompt, abort) and
 * streams the documented event sequence. A prompt of "/hang" starts a run that never finishes
 * until aborted.
 */
export class FakePiProcess implements RunningProcess {
  readonly args: string[];
  readonly received: Record<string, unknown>[] = [];
  private stdout: Cb<Buffer>[] = [];
  private stderr: Cb<Buffer>[] = [];
  private exit: Cb<number | null>[] = [];
  private inbox = '';
  private dead = false;
  private run: { aborted: boolean } | null = null;
  private readonly sessionFile: string;

  constructor(
    args: string[],
    private readonly opts: FakePiOptions = {},
  ) {
    this.args = args;
    const i = args.indexOf('--session');
    this.sessionFile =
      i >= 0 && args[i + 1]
        ? args[i + 1]!
        : `/home/sandbox/.pi/agent/sessions/fake-${Date.now()}.jsonl`;
  }

  onStdout(cb: Cb<string | Buffer>) {
    this.stdout.push((b) => cb(b));
  }
  onStderr(cb: Cb<string | Buffer>) {
    this.stderr.push((b) => cb(b));
  }
  onExit(cb: Cb<number | null>) {
    this.exit.push(cb);
  }

  write(data: string) {
    if (this.dead) return;
    this.inbox += data;
    let i: number;
    while ((i = this.inbox.indexOf('\n')) !== -1) {
      const line = this.inbox.slice(0, i);
      this.inbox = this.inbox.slice(i + 1);
      if (line.trim()) void this.handle(line);
    }
  }

  kill() {
    this.die(137);
  }

  /** Simulates an unexpected crash. */
  crash(code = 1) {
    this.stderrLine('fake pi crashed');
    this.die(code);
  }

  private die(code: number) {
    if (this.dead) return;
    this.dead = true;
    for (const cb of this.exit) cb(code);
  }

  private stderrLine(text: string) {
    for (const cb of this.stderr) cb(Buffer.from(text + '\n'));
  }

  private send(record: unknown) {
    if (this.dead) return;
    const buf = Buffer.from(JSON.stringify(record) + '\n');
    const size = this.opts.chunkSize ?? buf.length;
    for (let o = 0; o < buf.length; o += size) {
      const chunk = buf.subarray(o, o + size);
      for (const cb of this.stdout) cb(chunk);
    }
  }

  private respond(id: unknown, command: string, success: boolean, extra: object = {}) {
    this.send({
      ...(id === undefined ? {} : { id }),
      type: 'response',
      command,
      success,
      ...extra,
    });
  }

  private async handle(line: string) {
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.send({
        type: 'response',
        command: 'parse',
        success: false,
        error: `Failed to parse command: ${String(err)}`,
      });
      return;
    }
    this.received.push(cmd);
    const { id } = cmd;
    switch (cmd.type) {
      case 'get_state':
        this.respond(id, 'get_state', true, {
          data: {
            isStreaming: this.run !== null,
            sessionFile: this.sessionFile,
            sessionId: 'fake',
          },
        });
        return;
      case 'prompt': {
        if (typeof cmd.message !== 'string') {
          this.respond(id, 'prompt', false, { error: 'message must be a string' });
          return;
        }
        if (this.run) {
          if (cmd.streamingBehavior !== 'steer' && cmd.streamingBehavior !== 'followUp') {
            this.respond(id, 'prompt', false, {
              error: 'Agent is streaming; specify streamingBehavior',
            });
            return;
          }
          this.respond(id, 'prompt', true, { data: { disposition: 'queued' } });
          return;
        }
        this.respond(id, 'prompt', true, { data: { disposition: 'started' } });
        await this.runPrompt(cmd.message);
        return;
      }
      case 'abort':
        if (this.run) this.run.aborted = true;
        this.respond(id, 'abort', true);
        return;
      default:
        this.respond(id, String(cmd.type), false, {
          error: `Unknown command: ${String(cmd.type)}`,
        });
    }
  }

  private async runPrompt(message: string) {
    const run = { aborted: false };
    this.run = run;
    const user = { role: 'user', content: message, timestamp: Date.now() };
    this.send({ type: 'agent_start' });
    this.send({ type: 'turn_start' });
    this.send({ type: 'message_start', message: user });
    this.send({ type: 'message_end', message: user });
    const reply = message === '/hang' ? '' : `You said: ${message}`;
    const assistant = { role: 'assistant', content: [{ type: 'text', text: reply }] };
    this.send({ type: 'message_start', message: { ...assistant, content: [] } });
    if (message === '/hang') {
      while (!run.aborted && !this.dead) await tick();
    } else {
      for (const word of reply.split(/(?<= )/)) {
        if (run.aborted || this.dead) break;
        this.send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: word },
        });
        await tick();
      }
    }
    if (!run.aborted) {
      this.send({ type: 'message_end', message: assistant });
      this.send({ type: 'turn_end', message: assistant, toolResults: [] });
    }
    this.send({ type: 'agent_end', messages: [], willRetry: false });
    this.send({ type: 'agent_settled', aborted: run.aborted });
    this.run = null;
  }
}
