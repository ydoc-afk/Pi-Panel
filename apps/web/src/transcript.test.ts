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
});
