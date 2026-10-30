import type { StreamMessage } from './api.js';

export interface Item {
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
}

export interface Transcript {
  items: Item[];
  /** Assistant text streamed so far for the message in progress. */
  streaming: string;
  running: boolean;
  lastSeq: number;
}

export const emptyTranscript: Transcript = { items: [], streaming: '', running: false, lastSeq: 0 };

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
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
      const msg = e.message as { role?: string; content?: unknown } | undefined;
      const text = messageText(msg?.content);
      if (msg?.role === 'user') return { ...next, items: [...t.items, { kind: 'user', text }] };
      if (msg?.role === 'assistant') {
        return {
          ...next,
          streaming: '',
          items: text ? [...t.items, { kind: 'assistant', text }] : t.items,
        };
      }
      return next;
    }
    case 'message_update': {
      const ev = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      return ev?.type === 'text_delta'
        ? { ...next, streaming: t.streaming + (ev.delta ?? '') }
        : next;
    }
    case 'tool_execution_start':
      return {
        ...next,
        items: [...t.items, { kind: 'tool', text: `Running ${String(e.toolName)}...` }],
      };
    case 'tool_execution_end':
      return {
        ...next,
        items: [
          ...t.items,
          { kind: 'tool', text: `${e.isError ? 'Failed' : 'Finished'} ${String(e.toolName)}` },
        ],
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
