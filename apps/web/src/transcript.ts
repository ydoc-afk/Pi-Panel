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

/** A question an extension asked, waiting for the user. */
export interface UiDialog {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface UiWidget {
  lines: string[];
  placement: 'above' | 'below';
}

/** What extensions have put on screen: status entries, widgets, open questions and a title. */
export interface UiState {
  statuses: Record<string, string>;
  widgets: Record<string, UiWidget>;
  dialogs: UiDialog[];
  title: string;
  /** Text an extension asked to put in the prompt box; seq tells repeats apart. */
  editorText: { text: string; seq: number } | null;
}

/** One entry of the agent's todo list, as the todo tool reports it. */
export interface Task {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Shown while the task is in progress ("writing the report"). */
  activeForm?: string;
}

export const emptyUi: UiState = {
  statuses: {},
  widgets: {},
  dialogs: [],
  title: '',
  editorText: null,
};

export interface Transcript {
  items: Item[];
  /** Assistant text streamed so far for the message in progress. */
  streaming: string;
  running: boolean;
  lastSeq: number;
  ui: UiState;
  /** The agent's current todo list: every todo tool result carries the whole list. */
  tasks: Task[];
}

export const emptyTranscript: Transcript = {
  items: [],
  streaming: '',
  running: false,
  lastSeq: 0,
  ui: emptyUi,
  tasks: [],
};

const MAX_OUTPUT = 20_000;

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Extensions colour their text for a terminal; the escape codes would show as junk here. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** The task list inside a todo tool result, or undefined if the result carries none. */
function tasksFrom(result: unknown): Task[] | undefined {
  const details = (result as { details?: { tasks?: unknown } } | undefined)?.details;
  if (!Array.isArray(details?.tasks)) return undefined;
  const out: Task[] = [];
  for (const raw of details.tasks) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const status = r.status;
    if (typeof r.subject !== 'string' || !r.subject) continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue; // e.g. deleted
    out.push({
      id: String(r.id ?? out.length + 1),
      subject: r.subject.slice(0, 300),
      status,
      ...(typeof r.activeForm === 'string' && r.activeForm
        ? { activeForm: r.activeForm.slice(0, 300) }
        : {}),
    });
  }
  return out;
}

/** Folds one extension_ui_request into the UI state; notify becomes a line in the transcript. */
function applyUiRequest(t: Transcript, e: Record<string, unknown>, seq: number): Transcript {
  const ui = t.ui;
  switch (e.method) {
    case 'setStatus': {
      const key = str(e.statusKey);
      if (!key) return t;
      const statuses = { ...ui.statuses };
      const text = typeof e.statusText === 'string' ? stripAnsi(e.statusText).trim() : '';
      if (text) statuses[key] = text;
      else delete statuses[key];
      return { ...t, ui: { ...ui, statuses } };
    }
    case 'setWidget': {
      const key = str(e.widgetKey);
      if (!key) return t;
      const widgets = { ...ui.widgets };
      if (Array.isArray(e.widgetLines)) {
        widgets[key] = {
          lines: e.widgetLines.filter((l): l is string => typeof l === 'string').map(stripAnsi),
          placement: e.widgetPlacement === 'belowEditor' ? 'below' : 'above',
        };
      } else delete widgets[key];
      return { ...t, ui: { ...ui, widgets } };
    }
    case 'setTitle':
      return { ...t, ui: { ...ui, title: stripAnsi(str(e.title)) } };
    case 'set_editor_text':
      return { ...t, ui: { ...ui, editorText: { text: str(e.text), seq } } };
    case 'notify': {
      const mark = e.notifyType === 'error' ? '✗ ' : e.notifyType === 'warning' ? '⚠ ' : '';
      const text = `${mark}${stripAnsi(str(e.message))}`;
      return { ...t, items: [...t.items, { kind: 'notice', text }] };
    }
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor': {
      const id = str(e.id);
      if (!id || ui.dialogs.some((d) => d.id === id)) return t;
      const dialog: UiDialog = {
        id,
        method: e.method,
        title: stripAnsi(str(e.title)),
        ...(typeof e.message === 'string' ? { message: stripAnsi(e.message) } : {}),
        ...(Array.isArray(e.options)
          ? { options: e.options.filter((o): o is string => typeof o === 'string') }
          : {}),
        ...(typeof e.placeholder === 'string' ? { placeholder: e.placeholder } : {}),
        ...(typeof e.prefill === 'string' ? { prefill: e.prefill } : {}),
      };
      return { ...t, ui: { ...ui, dialogs: [...ui.dialogs, dialog] } };
    }
    default:
      return t;
  }
}

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
    case 'todo': {
      // "update #3 in_progress", "create Write the report": what the call does, not its JSON.
      const detail = [a.id !== undefined ? `#${String(a.id)}` : '', str(a.status), str(a.subject)]
        .filter(Boolean)
        .join(' ');
      s = [str(a.action), detail].filter(Boolean).join(' ');
      break;
    }
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
    case 'extension_ui_request':
      return applyUiRequest(next, e, m.seq);
    case 'panel_ui_resolved':
      return { ...next, ui: { ...t.ui, dialogs: t.ui.dialogs.filter((d) => d.id !== e.id) } };
    case 'panel_ui_reset':
      return { ...next, ui: emptyUi };
    case 'agent_start':
      return { ...next, running: true };
    case 'agent_settled':
      return { ...next, running: false, streaming: '' };
    case 'message_end': {
      const msg = e.message as
        | { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }
        | undefined;
      const text = messageText(msg?.content);
      if (msg?.role === 'user') {
        // A prompt box prefill that was sent is spent.
        return {
          ...next,
          items: [...t.items, { kind: 'user', text }],
          ui: t.ui.editorText ? { ...t.ui, editorText: null } : t.ui,
        };
      }
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
      const tasks = e.toolName === 'todo' && !e.isError ? tasksFrom(e.result) : undefined;
      if (tasks) next.tasks = tasks;
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
