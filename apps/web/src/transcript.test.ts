import { describe, expect, it } from 'vitest';
import {
  applyMessage,
  emptyTranscript,
  toMarkdown,
  toolSummary,
  type Transcript,
} from './transcript.js';

const feed = (events: Record<string, unknown>[]): Transcript =>
  events.reduce<Transcript>(
    (t, event, i) => applyMessage(t, { seq: i + 1, event: event as { type: string } }),
    emptyTranscript,
  );

describe('transcript', () => {
  it('shows one line per tool call, updated with its result', () => {
    const t = feed([
      {
        type: 'tool_execution_start',
        toolCallId: 'a',
        toolName: 'bash',
        args: { command: 'ls -la' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'a',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'file.txt' }] },
      },
    ]);
    expect(t.items).toEqual([
      { kind: 'tool', text: 'bash ls -la', callId: 'a', state: 'done', output: 'file.txt' },
    ]);
  });

  it('marks failed tools and matches results to the right call', () => {
    const t = feed([
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: { path: 'b.ts' } },
      {
        type: 'tool_execution_end',
        toolCallId: 'a',
        toolName: 'read',
        isError: true,
        result: 'nope',
      },
    ]);
    expect(t.items.map((i) => [i.text, i.state])).toEqual([
      ['read a.ts', 'failed'],
      ['read b.ts', 'running'],
    ]);
  });

  it('surfaces assistant errors that would otherwise end the run silently', () => {
    const t = feed([
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '429 rate limited',
        },
      },
    ]);
    expect(t.items).toEqual([{ kind: 'error', text: '429 rate limited' }]);
  });

  it('ignores events it has already applied', () => {
    const once = feed([{ type: 'message_end', message: { role: 'user', content: 'hi' } }]);
    expect(applyMessage(once, { seq: 1, event: { type: 'agent_start' } })).toBe(once);
  });

  it('summarises tool calls briefly', () => {
    expect(toolSummary('grep', { pattern: 'TODO', path: 'src' })).toBe('TODO in src');
    expect(toolSummary('bash', { command: 'x'.repeat(300) })).toHaveLength(140);
    expect(toolSummary('custom', {})).toBe('');
  });

  it('exports Markdown', () => {
    const t = feed([
      { type: 'message_end', message: { role: 'user', content: 'list files' } },
      { type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', result: 'a\nb' },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Two files.' }] },
      },
    ]);
    expect(toMarkdown(t, 'Demo')).toBe(
      [
        '# Demo',
        '',
        '**You:** list files',
        '',
        '- `bash ls` (ok)',
        '',
        '  ```',
        '  a',
        '  b',
        '  ```',
        '',
        'Two files.',
        '',
      ].join('\n'),
    );
  });

  describe('extension UI', () => {
    const req = (fields: Record<string, unknown>) => ({
      type: 'extension_ui_request',
      id: 'x',
      ...fields,
    });

    it('keeps statuses and widgets by key, strips colour codes, and clears them', () => {
      const t = feed([
        req({
          method: 'setStatus',
          statusKey: 'lsp',
          statusText: '\u001b[38;5;2mLSP Active\u001b[39m',
        }),
        req({ method: 'setWidget', widgetKey: 'w', widgetLines: ['a', '\u001b[1mb\u001b[22m'] }),
        req({
          method: 'setWidget',
          widgetKey: 'b',
          widgetLines: ['below'],
          widgetPlacement: 'belowEditor',
        }),
        req({ method: 'setTitle', title: 'pi - proj' }),
      ]);
      expect(t.ui.statuses).toEqual({ lsp: 'LSP Active' });
      expect(t.ui.widgets.w).toEqual({ lines: ['a', 'b'], placement: 'above' });
      expect(t.ui.widgets.b!.placement).toBe('below');
      expect(t.ui.title).toBe('pi - proj');

      const cleared = feed([
        req({ method: 'setStatus', statusKey: 'lsp', statusText: 'on' }),
        req({ method: 'setStatus', statusKey: 'lsp' }),
        req({ method: 'setWidget', widgetKey: 'w', widgetLines: ['a'] }),
        req({ method: 'setWidget', widgetKey: 'w' }),
      ]);
      expect(cleared.ui.statuses).toEqual({});
      expect(cleared.ui.widgets).toEqual({});
    });

    it('opens a dialog until it is resolved, and forgets everything on reset', () => {
      const open = feed([
        req({ id: 'q1', method: 'select', title: 'Pick', options: ['A', 'B', 3] }),
        req({ id: 'q1', method: 'select', title: 'Pick', options: ['A', 'B'] }),
        req({ id: 'q2', method: 'confirm', title: 'Sure?', message: 'really' }),
        req({ method: 'setStatus', statusKey: 's', statusText: 'on' }),
      ]);
      expect(open.ui.dialogs.map((d) => d.id)).toEqual(['q1', 'q2']);
      expect(open.ui.dialogs[0]!.options).toEqual(['A', 'B']);

      const after = [{ type: 'panel_ui_resolved', id: 'q1' }].reduce<Transcript>(
        (t, event, i) => applyMessage(t, { seq: 100 + i, event }),
        open,
      );
      expect(after.ui.dialogs.map((d) => d.id)).toEqual(['q2']);

      const reset = applyMessage(open, { seq: 200, event: { type: 'panel_ui_reset' } });
      expect(reset.ui).toEqual(emptyTranscript.ui);
    });

    it('turns notify into a transcript line and spends a prompt prefill once sent', () => {
      const t = feed([
        req({ method: 'notify', message: 'careful', notifyType: 'warning' }),
        req({ method: 'set_editor_text', text: 'draft' }),
      ]);
      expect(t.items).toEqual([{ kind: 'notice', text: '⚠ careful' }]);
      expect(t.ui.editorText?.text).toBe('draft');
      const sent = applyMessage(t, {
        seq: 50,
        event: { type: 'message_end', message: { role: 'user', content: 'draft' } },
      });
      expect(sent.ui.editorText).toBeNull();
    });
  });

  describe('todo list', () => {
    const todoEnd = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
      type: 'tool_execution_end',
      toolCallId: 'c',
      toolName: 'todo',
      isError: false,
      result: { content: [{ type: 'text', text: 'ok' }], details: { tasks } },
      ...extra,
    });

    it('keeps the list from the newest todo result and drops deleted tasks', () => {
      const t = feed([
        todoEnd([{ id: 1, subject: 'One', status: 'pending' }]),
        todoEnd([
          { id: 1, subject: 'One', status: 'completed' },
          { id: 2, subject: 'Two', status: 'in_progress', activeForm: 'doing two' },
          { id: 3, subject: 'Gone', status: 'deleted' },
          { id: 4, status: 'pending' },
        ]),
      ]);
      expect(t.tasks).toEqual([
        { id: '1', subject: 'One', status: 'completed' },
        { id: '2', subject: 'Two', status: 'in_progress', activeForm: 'doing two' },
      ]);
    });

    it('ignores failed todo calls and other tools', () => {
      const t = feed([
        todoEnd([{ id: 1, subject: 'One', status: 'pending' }]),
        todoEnd([], { isError: true }),
        { ...todoEnd([]), toolName: 'bash' },
      ]);
      expect(t.tasks).toHaveLength(1);
    });

    it('summarises todo calls as what they do, not as JSON', () => {
      expect(toolSummary('todo', { action: 'update', id: 3, status: 'in_progress' })).toBe(
        'update #3 in_progress',
      );
      expect(toolSummary('todo', { action: 'create', subject: 'Write it' })).toBe(
        'create Write it',
      );
    });
  });
});
