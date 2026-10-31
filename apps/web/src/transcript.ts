import type { StreamMessage } from './api.js';

export interface Item {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error';
  text: string;
  /** Tools: pi's id for the call, so its end event updates the same line. */
  callId?: string;
  /** Tools: still running, finished, or failed. */
  state?: 'running' | 'done' | 'failed';
  /** Tools: output, shown when the line is expanded. */
  output?: string;
}

export interface Transcript {
  items: Item[];
  /** Assistant text streamed so far for the message in progress. */
  streaming: string;
  running: boolean;
  lastSeq: number;
}

export const emptyTranscript: Transcript = { items: [], streaming: '', running: false, lastSeq: 0 };

const MAX_OUTPUT = 20_000;

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One line saying what a tool call does: the command for bash, the path for file tools. */
export function toolSummary(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  let s: string;
  switch (name) {
    case 'bash':
      s = str(a.command);
      break;
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      s = str(a.path) || str(a.file_path);
      break;
    case 'grep':
    case 'find':
      s = [str(a.pattern) || str(a.glob), str(a.path)].filter(Boolean).join(' in ');
      break;
    default:
      s = Object.keys(a).length ? JSON.stringify(a) : '';
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

/** Text of a tool result: pi sends { content: [{ type: 'text', text }] }, or a plain string. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const r = result as { content?: unknown } | undefined;
  const text = messageText(r?.content);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n... output truncated` : text;
}

/** Folds one stream message into the transcript; messages at or before lastSeq are ignored. */
export function applyMessage(t: Transcript, m: StreamMessage): Transcript {
  if (m.seq <= t.lastSeq) return t;
  const next = { ...t, lastSeq: m.seq };
  const e = m.event;
  switch (e.type) {
    case 'agent_start':
      return { ...next, running: true };
    case 'agent_settled':
      return { ...next, running: false, streaming: '' };
    case 'message_end': {
      const msg = e.message as
        | { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }
        | undefined;
      const text = messageText(msg?.content);
      if (msg?.role === 'user') return { ...next, items: [...t.items, { kind: 'user', text }] };
      if (msg?.role === 'assistant') {
        const items: Item[] = text ? [...t.items, { kind: 'assistant', text }] : [...t.items];
        // A failed model call ends with no text; without this the run would just stop silently.
        if (msg.stopReason === 'error' || msg.errorMessage) {
          items.push({ kind: 'error', text: msg.errorMessage || 'The model returned an error' });
        }
        return { ...next, streaming: '', items };
      }
      return next;
    }
    case 'message_update': {
      const ev = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      return ev?.type === 'text_delta'
        ? { ...next, streaming: t.streaming + (ev.delta ?? '') }
        : next;
    }
    case 'tool_execution_start': {
      const name = String(e.toolName);
      const summary = toolSummary(name, e.args);
      return {
        ...next,
        items: [
          ...t.items,
          {
            kind: 'tool',
            text: summary ? `${name} ${summary}` : name,
            callId: str(e.toolCallId) || undefined,
            state: 'running',
          },
        ],
      };
    }
    case 'tool_execution_end': {
      const state = e.isError ? 'failed' : 'done';
      const output = resultText(e.result);
      const callId = str(e.toolCallId);
      let i = -1;
      for (let j = t.items.length - 1; j >= 0; j--) {
        const it = t.items[j]!;
        if (it.kind === 'tool' && it.state === 'running' && (!callId || it.callId === callId)) {
          i = j;
          break;
        }
      }
      if (i < 0) {
        return {
          ...next,
          items: [...t.items, { kind: 'tool', text: String(e.toolName), state, output }],
        };
      }
      const items = [...t.items];
      items[i] = { ...items[i]!, state, output };
      return { ...next, items };
    }
    case 'panel_notice':
      return {
        ...next,
        items: [...t.items, { kind: 'notice', text: String(e.message ?? 'Notice from the panel') }],
      };
    case 'panel_process_exit':
      return {
        ...next,
        running: false,
        items: [
          ...t.items,
          { kind: 'notice', text: `pi exited unexpectedly (code ${String(e.code)})` },
        ],
      };
    default:
      return next;
  }
}

/** The transcript as Markdown, for saving or sharing. */
export function toMarkdown(t: Transcript, title: string): string {
  const out = [`# ${title}`, ''];
  for (const it of t.items) {
    switch (it.kind) {
      case 'user':
        out.push(`**You:** ${it.text}`, '');
        break;
      case 'assistant':
        out.push(it.text, '');
        break;
      case 'tool': {
        const mark = it.state === 'failed' ? 'failed' : it.state === 'running' ? 'running' : 'ok';
        out.push(`- \`${it.text}\` (${mark})`);
        if (it.output)
          out.push('', '  ```', ...it.output.split('\n').map((l) => `  ${l}`), '  ```');
        out.push('');
        break;
      }
      case 'notice':
      case 'error':
        out.push(`> ${it.kind === 'error' ? 'Error: ' : ''}${it.text}`, '');
        break;
    }
  }
  if (t.streaming) out.push(t.streaming, '');
  return out.join('\n');
}
