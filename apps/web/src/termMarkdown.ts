/** A small Markdown reader for terminal output: just what an agent's replies tend to use. */
export type Block =
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'rule' }
  | { type: 'para'; text: string };

export type Span = { type: 'text' | 'code' | 'bold' | 'italic'; text: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Splits text into blocks. An unclosed code fence (mid-stream) runs to the end of the text. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++)
        body.push(lines[i]!);
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      flush();
      const ordered = !BULLET.test(line);
      const items = [item[1]!];
      while (i + 1 < lines.length) {
        const more = (ordered ? NUMBERED : BULLET).exec(lines[i + 1]!);
        if (!more) break;
        items.push(more[1]!);
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const quote = [line.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && lines[i + 1]!.startsWith('>')) {
        quote.push(lines[++i]!.replace(/^>\s?/, ''));
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return blocks;
}

/** Splits a line of text into plain, `code`, **bold** and *italic* spans. */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\w*])\*(?=\S)([^*\n]*\S)\*(?![\w*])/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) spans.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ type: 'code', text: m[1] });
    else if (m[2] !== undefined) spans.push({ type: 'bold', text: m[2] });
    else spans.push({ type: 'italic', text: m[3]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ type: 'text', text: text.slice(last) });
  return spans;
}
