import { describe, expect, it } from 'vitest';
import { parseBlocks, parseSpans } from './termMarkdown.js';

describe('parseBlocks', () => {
  it('reads paragraphs, headings, lists and rules', () => {
    expect(parseBlocks('# Title\n\nHello\nworld\n\n- a\n- b\n\n1. x\n2. y\n\n---')).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'para', text: 'Hello\nworld' },
      { type: 'list', ordered: false, items: ['a', 'b'] },
      { type: 'list', ordered: true, items: ['x', 'y'] },
      { type: 'rule' },
    ]);
  });

  it('keeps fenced code verbatim, including blank lines and markup', () => {
    expect(parseBlocks('before\n```ts\nconst a = 1;\n\n# not a heading\n```\nafter')).toEqual([
      { type: 'para', text: 'before' },
      { type: 'code', lang: 'ts', text: 'const a = 1;\n\n# not a heading' },
      { type: 'para', text: 'after' },
    ]);
  });

  it('treats an unclosed fence, as seen while streaming, as code to the end', () => {
    expect(parseBlocks('run:\n```bash\nls -la')).toEqual([
      { type: 'para', text: 'run:' },
      { type: 'code', lang: 'bash', text: 'ls -la' },
    ]);
  });

  it('reads block quotes', () => {
    expect(parseBlocks('> a\n> b')).toEqual([{ type: 'quote', text: 'a\nb' }]);
  });
});

describe('parseSpans', () => {
  it('finds code, bold and italic', () => {
    expect(parseSpans('use `npm i` and **care** with *this*')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'npm i' },
      { type: 'text', text: ' and ' },
      { type: 'bold', text: 'care' },
      { type: 'text', text: ' with ' },
      { type: 'italic', text: 'this' },
    ]);
  });

  it('leaves stray asterisks alone', () => {
    expect(parseSpans('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
  });
});
