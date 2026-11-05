import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningProcess } from './runtime.js';

export interface FakePiOptions {
  /** Split stdout writes into chunks of this many bytes, to exercise record framing. */
  chunkSize?: number;
  /** Host dir standing in for pi's agent dir; the fake `pi install/remove/list` CLI edits settings.json there. */
  agentDir?: string;
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
  private thinkingLevel = 'medium';
  private autoCompaction = true;
  /** Context the fake reports, grown by each prompt so token stats move. */
  private prompts = 0;

  constructor(
    args: string[],
    private readonly opts: FakePiOptions = {},
  ) {
    this.args = args;
    const i = args.indexOf('--session');
    const sub = args[0];
    if (sub === 'install' || sub === 'remove' || sub === 'list') {
      setImmediate(() => this.runCli(sub, args[1]));
    }
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

  get exited() {
    return this.dead;
  }

  private runCli(sub: string, source: string | undefined) {
    const out = (text: string) => {
      for (const cb of this.stdout) cb(Buffer.from(text));
    };
    if (this.dead) return;
    const dir = this.opts.agentDir;
    if (!dir) return this.die(2);
    const file = join(dir, 'settings.json');
    let settings: { packages?: unknown[] } = {};
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as typeof settings;
    } catch {
      /* no settings yet */
    }
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const sourceOf = (e: unknown) =>
      typeof e === 'string' ? e : (e as { source?: string }).source;
    if (sub === 'list') {
      out(packages.map(sourceOf).join('\n') + '\n');
      return this.die(0);
    }
    if (!source || source.includes('fail')) {
      this.stderrLine(`npm error 404 Not Found - GET https://registry.npmjs.org/${source ?? ''}`);
      return this.die(1);
    }
    const next = packages.filter((e) => sourceOf(e) !== source);
    if (sub === 'install') next.push(source);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ...settings, packages: next }, null, 2));
    out(`${sub === 'install' ? 'Installed' : 'Removed'} ${source}\n`);
    this.die(0);
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
            isCompacting: false,
            thinkingLevel: this.thinkingLevel,
            autoCompactionEnabled: this.autoCompaction,
            model: { id: 'fake-model', provider: 'fake', contextWindow: 100000, reasoning: true },
            sessionFile: this.sessionFile,
            sessionId: 'fake',
          },
        });
        return;
      case 'get_available_thinking_levels':
        this.respond(id, 'get_available_thinking_levels', true, {
          data: { levels: ['off', 'minimal', 'low', 'medium', 'high'] },
        });
        return;
      case 'set_thinking_level':
        if (!['off', 'minimal', 'low', 'medium', 'high'].includes(String(cmd.level))) {
          this.respond(id, 'set_thinking_level', false, {
            error: `Unsupported thinking level: ${String(cmd.level)}`,
          });
        } else {
          this.thinkingLevel = String(cmd.level);
          this.respond(id, 'set_thinking_level', true);
        }
        return;
      case 'set_auto_compaction':
        this.autoCompaction = cmd.enabled === true;
        this.respond(id, 'set_auto_compaction', true);
        return;
      case 'get_session_stats':
        this.respond(id, 'get_session_stats', true, {
          data: {
            userMessages: this.prompts,
            assistantMessages: this.prompts,
            toolCalls: 0,
            totalMessages: this.prompts * 2,
            tokens: {
              input: this.prompts * 1000,
              output: this.prompts * 200,
              cacheRead: 0,
              cacheWrite: 0,
              total: this.prompts * 1200,
            },
            cost: this.prompts * 0.01,
            contextUsage: {
              tokens: this.prompts * 1200,
              contextWindow: 100000,
              percent: (this.prompts * 1200) / 1000,
            },
          },
        });
        return;
      case 'compact':
        if (this.prompts === 0) {
          this.respond(id, 'compact', false, { error: 'Nothing to compact' });
          return;
        }
        this.respond(id, 'compact', true, {
          data: {
            summary: `Summary${cmd.customInstructions ? ` (${String(cmd.customInstructions)})` : ''}`,
            tokensBefore: this.prompts * 1200,
            estimatedTokensAfter: 300,
          },
        });
        this.prompts = 0;
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
        this.prompts += 1;
        await this.runPrompt(cmd.message);
        return;
      }
      case 'extension_ui_response':
        // Answers to dialogs the fake asked; pi sends no response record for these.
        this.uiAnswers.set(String(cmd.id), cmd);
        return;
      case 'set_model':
        if (cmd.modelId === 'missing-model') {
          this.respond(id, 'set_model', false, {
            error: `Model not found: ${String(cmd.modelId)}`,
          });
        } else {
          this.respond(id, 'set_model', true, {
            data: { id: cmd.modelId, provider: cmd.provider },
          });
        }
        return;
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

  private uiSeq = 0;
  private readonly uiAnswers = new Map<string, Record<string, unknown>>();

  private async runPrompt(message: string) {
    const run = { aborted: false };
    this.run = run;
    const user = { role: 'user', content: message, timestamp: Date.now() };
    this.send({ type: 'agent_start' });
    this.send({ type: 'turn_start' });
    this.send({ type: 'message_start', message: user });
    this.send({ type: 'message_end', message: user });
    // "/ui [timeout-ms]" shows extension UI: a repeated status, a widget, a clear of nothing, then a
    // confirm dialog it waits on (or times out of, like pi does).
    if (message.startsWith('/ui')) {
      const timeout = Number(message.slice(3)) || undefined;
      const ui = (fields: object) =>
        this.send({ type: 'extension_ui_request', id: `ui-${++this.uiSeq}`, ...fields });
      ui({
        method: 'setStatus',
        statusKey: 'lsp',
        statusText: '\u001b[38;5;2mLSP Active\u001b[39m',
      });
      ui({
        method: 'setStatus',
        statusKey: 'lsp',
        statusText: '\u001b[38;5;2mLSP Active\u001b[39m',
      });
      ui({ method: 'setWidget', widgetKey: 'tasks', widgetLines: ['one', 'two'] });
      ui({ method: 'setWidget', widgetKey: 'ghost' });
      const askId = `ui-${++this.uiSeq}`;
      this.send({
        type: 'extension_ui_request',
        id: askId,
        method: 'confirm',
        title: 'Allow it?',
        message: 'Really?',
        ...(timeout ? { timeout } : {}),
      });
      const waitUntil = Date.now() + (timeout ?? 60_000);
      while (!this.uiAnswers.has(askId) && !run.aborted && !this.dead && Date.now() < waitUntil) {
        await tick();
      }
      const answer = this.uiAnswers.get(askId);
      message = `answer: ${answer ? JSON.stringify({ ...answer, id: undefined }) : 'none'}`;
    }
    // "/push <json>" is what the push_to_repo tool does: ask the reserved dialog and wait for the outcome.
    if (message.startsWith('/push ')) {
      const askId = `ui-${++this.uiSeq}`;
      this.send({
        type: 'extension_ui_request',
        id: askId,
        method: 'input',
        title: '@pi-panel/push',
        placeholder: message.slice(6),
      });
      while (!this.uiAnswers.has(askId) && !run.aborted && !this.dead) await tick();
      const answer = this.uiAnswers.get(askId);
      message = `result: ${answer?.cancelled ? 'cancelled' : String(answer?.value)}`;
    }
    // "/pr <json>" is what the open_pull_request tool does, through its own reserved dialog.
    if (message.startsWith('/pr ')) {
      const askId = `ui-${++this.uiSeq}`;
      this.send({
        type: 'extension_ui_request',
        id: askId,
        method: 'input',
        title: '@pi-panel/pull-request',
        placeholder: message.slice(4),
      });
      while (!this.uiAnswers.has(askId) && !run.aborted && !this.dead) await tick();
      const answer = this.uiAnswers.get(askId);
      message = `result: ${answer?.cancelled ? 'cancelled' : String(answer?.value)}`;
    }
    // "/fail <text>" ends the turn like a rejected model call: no text, stopReason "error".
    const failure = message.startsWith('/fail ') ? message.slice(6) : null;
    const reply = message === '/hang' || failure !== null ? '' : `You said: ${message}`;
    const assistant = {
      role: 'assistant',
      content: failure !== null ? [] : [{ type: 'text', text: reply }],
      ...(failure !== null ? { stopReason: 'error', errorMessage: failure } : {}),
    };
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
