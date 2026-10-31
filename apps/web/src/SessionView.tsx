import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Group, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import { IconArrowDown, IconCheck, IconCopy, IconDownload } from '@tabler/icons-react';
import { abortSession, fetchEvents, openStream, sendPrompt } from './api.js';
import {
  applyMessage,
  emptyTranscript,
  toMarkdown,
  type Item,
  type Transcript,
} from './transcript.js';
import type { StreamMessage } from './api.js';
import { ErrorText, Tip } from './ui.js';
import { parseBlocks, parseSpans } from './termMarkdown.js';

// A terminal looks the same in light and dark mode, so these colours are fixed.
const TERM = {
  bg: '#0b0f14',
  bar: '#161b22',
  fg: '#d6dde6',
  dim: '#6b7785',
  prompt: '#4fd1c5',
  tool: '#8b9bb4',
  ok: '#3fb950',
  bad: '#f85149',
  warn: '#e3b341',
  border: '#2a313c',
  userBg: '#12202b',
  codeBg: '#10161d',
  accent: '#79c0ff',
};
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
/** Within this many pixels of the bottom counts as "following" the output. */
const STICKY_PX = 48;

function Spans({ text }: { text: string }) {
  return (
    <>
      {parseSpans(text).map((sp, i) => {
        switch (sp.type) {
          case 'code':
            return (
              <code
                key={i}
                style={{
                  background: TERM.codeBg,
                  border: `1px solid ${TERM.border}`,
                  borderRadius: 4,
                  padding: '0 5px',
                  color: TERM.accent,
                  fontFamily: 'inherit',
                  fontSize: '0.92em',
                }}
              >
                {sp.text}
              </code>
            );
          case 'bold':
            return (
              <strong key={i} style={{ color: '#fff' }}>
                {sp.text}
              </strong>
            );
          case 'italic':
            return <em key={i}>{sp.text}</em>;
          default:
            return <span key={i}>{sp.text}</span>;
        }
      })}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tip label="Copy">
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={{
          background: 'none',
          border: 0,
          color: copied ? TERM.ok : TERM.dim,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'inherit',
          fontSize: 11,
          padding: 0,
        }}
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        {copied ? 'copied' : 'copy'}
      </button>
    </Tip>
  );
}

/** An agent reply: paragraphs, headings, lists and code blocks rather than a wall of raw text. */
function Reply({ text }: { text: string }) {
  return (
    <div style={{ margin: '8px 0 10px', paddingLeft: 12, borderLeft: `2px solid ${TERM.border}` }}>
      {parseBlocks(text).map((b, i) => {
        const gap = i === 0 ? 0 : 8;
        switch (b.type) {
          case 'code':
            return (
              <div
                key={i}
                style={{
                  marginTop: gap,
                  background: TERM.codeBg,
                  border: `1px solid ${TERM.border}`,
                  borderRadius: 6,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '2px 10px',
                    background: TERM.bar,
                    color: TERM.dim,
                    fontSize: 11,
                  }}
                >
                  <span>{b.lang || 'text'}</span>
                  <CopyButton text={b.text} />
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '8px 12px',
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                    fontFamily: 'inherit',
                    color: TERM.fg,
                  }}
                >
                  {b.text}
                </pre>
              </div>
            );
          case 'heading':
            return (
              <div
                key={i}
                style={{
                  marginTop: gap + 4,
                  color: TERM.accent,
                  fontWeight: 700,
                  fontSize: b.level <= 2 ? 15 : 13.5,
                }}
              >
                <Spans text={b.text} />
              </div>
            );
          case 'list':
            return (
              <div key={i} style={{ marginTop: gap }}>
                {b.items.map((it, j) => (
                  <div key={j} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: TERM.prompt, minWidth: 18, textAlign: 'right' }}>
                      {b.ordered ? `${j + 1}.` : '•'}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <Spans text={it} />
                    </span>
                  </div>
                ))}
              </div>
            );
          case 'quote':
            return (
              <div
                key={i}
                style={{
                  marginTop: gap,
                  paddingLeft: 10,
                  borderLeft: `2px solid ${TERM.warn}`,
                  color: TERM.tool,
                }}
              >
                <Spans text={b.text} />
              </div>
            );
          case 'rule':
            return (
              <hr
                key={i}
                style={{
                  margin: `${gap + 4}px 0`,
                  border: 0,
                  borderTop: `1px solid ${TERM.border}`,
                }}
              />
            );
          default:
            return (
              <div key={i} style={{ marginTop: gap, color: TERM.fg }}>
                <Spans text={b.text} />
              </div>
            );
        }
      })}
    </div>
  );
}

function ToolLine({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const color = item.state === 'failed' ? TERM.bad : item.state === 'done' ? TERM.ok : TERM.warn;
  const expandable = !!item.output;
  const space = item.text.indexOf(' ');
  const name = space < 0 ? item.text : item.text.slice(0, space);
  const detail = space < 0 ? '' : item.text.slice(space + 1);
  return (
    <div style={{ margin: '2px 0' }}>
      <div
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen(!open)}
        onKeyDown={(e) => expandable && e.key === 'Enter' && setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '1px 8px',
          marginLeft: 12,
          borderRadius: 4,
          background: open ? TERM.bar : 'transparent',
          cursor: expandable ? 'pointer' : 'default',
          color: TERM.tool,
        }}
      >
        <span style={{ color, width: 12, flexShrink: 0 }}>
          {item.state === 'running' ? (
            <span className="pp-blink">●</span>
          ) : item.state === 'failed' ? (
            '✗'
          ) : (
            '✓'
          )}
        </span>
        <span
          style={{
            color: TERM.accent,
            fontWeight: 600,
            background: TERM.codeBg,
            border: `1px solid ${TERM.border}`,
            borderRadius: 4,
            padding: '0 6px',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {name}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: open ? 'pre-wrap' : 'nowrap',
            wordBreak: 'break-all',
          }}
        >
          {detail}
        </span>
        {expandable && <span style={{ color: TERM.dim }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && (
        <div
          style={{
            color: TERM.dim,
            background: TERM.codeBg,
            border: `1px solid ${TERM.border}`,
            borderRadius: 6,
            margin: '4px 0 6px 32px',
            padding: '6px 10px',
            maxHeight: 320,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {item.output}
        </div>
      )}
    </div>
  );
}

/** How each kind of transcript line reads in the terminal. */
function Line({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return (
        <div
          style={{
            background: TERM.userBg,
            borderLeft: `3px solid ${TERM.prompt}`,
            borderRadius: '0 6px 6px 0',
            color: '#fff',
            fontWeight: 600,
            margin: '14px 0 6px',
            padding: '6px 12px',
          }}
        >
          <span style={{ color: TERM.prompt }}>❯ </span>
          {item.text}
        </div>
      );
    case 'tool':
      return <ToolLine item={item} />;
    case 'notice':
      return <div style={{ color: TERM.warn, margin: '6px 0 6px 12px' }}>{`⚠ ${item.text}`}</div>;
    case 'error':
      return (
        <div
          style={{
            color: TERM.bad,
            background: '#2a1517',
            border: `1px solid #5a2328`,
            borderRadius: 6,
            margin: '6px 0 6px 12px',
            padding: '4px 10px',
          }}
        >{`✗ ${item.text}`}</div>
      );
    default:
      return <Reply text={item.text} />;
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SessionView({ sessionId, name }: { sessionId: number; name?: string }) {
  const [t, push] = useReducer(
    (state: Transcript, m: StreamMessage | 'reset') =>
      m === 'reset' ? emptyTranscript : applyMessage(state, m),
    emptyTranscript,
  );
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'steer' | 'followUp'>('steer');
  const [following, setFollowing] = useState(true);
  const lastSeq = useRef(0);
  const history = useRef<string[]>([]);
  const screen = useRef<HTMLDivElement>(null);
  lastSeq.current = Math.max(lastSeq.current, t.lastSeq);

  useEffect(() => {
    push('reset');
    lastSeq.current = 0;
    let cancelled = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      socket = openStream(sessionId, lastSeq.current);
      socket.onmessage = (ev) => push(JSON.parse(String(ev.data)) as StreamMessage);
      socket.onclose = () => {
        if (!cancelled) retry = setTimeout(connect, 2000);
      };
    };

    // Page through persisted history first, then stream; the socket replays anything after lastSeq.
    (async () => {
      try {
        for (;;) {
          const page = await fetchEvents(sessionId, lastSeq.current);
          if (cancelled) return;
          page.forEach((m) => push(m));
          if (page.length) lastSeq.current = page[page.length - 1]!.seq;
          if (page.length < 1000) break;
        }
        connect();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load session');
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [sessionId]);

  // Keep the newest output in view, as a terminal does, unless the reader has scrolled up.
  useEffect(() => {
    const el = screen.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [t.items, t.streaming, following]);

  function onScroll() {
    const el = screen.current;
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX);
  }

  function jumpToEnd() {
    setFollowing(true);
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  async function submit() {
    const message = text.trim();
    if (!message) return;
    setError('');
    try {
      await sendPrompt(sessionId, message, t.running ? mode : undefined);
      history.current = [...history.current.filter((h) => h !== message), message].slice(-50);
      setText('');
      jumpToEnd();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    }
  }

  function stop() {
    void abortSession(sessionId).catch((e: Error) => setError(e.message));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && t.running) {
      e.preventDefault();
      stop();
    } else if (e.key === 'ArrowUp' && !text && history.current.length) {
      // Like a shell: recall the last prompt into an empty input.
      e.preventDefault();
      setText(history.current[history.current.length - 1]!);
    }
  }

  return (
    <Stack gap="sm">
      <style>
        {
          '@keyframes pp-cursor { 50% { opacity: 0; } } @keyframes pp-blink { 50% { opacity: 0.25; } } .pp-blink { animation: pp-blink 1s steps(1) infinite; }'
        }
      </style>
      <div
        style={{
          background: TERM.bg,
          border: `1px solid ${TERM.border}`,
          borderRadius: 10,
          overflow: 'hidden',
          fontFamily: MONO,
          fontSize: 13.5,
          lineHeight: 1.6,
          position: 'relative',
        }}
      >
        <div
          style={{
            background: TERM.bar,
            padding: '6px 12px',
            color: TERM.dim,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: `1px solid ${TERM.border}`,
          }}
        >
          <span style={{ color: '#ff5f56' }}>●</span>
          <span style={{ color: '#ffbd2e' }}>●</span>
          <span style={{ color: '#27c93f' }}>●</span>
          <span
            style={{
              marginLeft: 8,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: TERM.fg,
            }}
          >
            {name || 'pi'}
          </span>
          <span
            className={t.running ? 'pp-blink' : undefined}
            style={{ color: t.running ? TERM.warn : TERM.ok, fontSize: 12 }}
          >
            {t.running ? '● working' : '● ready'}
          </span>
          <Tip label="Save the transcript as Markdown">
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={<IconDownload size={13} />}
              disabled={t.items.length === 0}
              styles={{
                root:
                  t.items.length === 0
                    ? { color: TERM.dim, background: 'transparent', opacity: 0.6 }
                    : { color: TERM.fg },
              }}
              onClick={() =>
                download(
                  `${(name || `session-${sessionId}`).replace(/[^\w.-]+/g, '-')}.md`,
                  toMarkdown(t, name || `Session ${sessionId}`),
                )
              }
            >
              Export
            </Button>
          </Tip>
        </div>
        <div
          ref={screen}
          onScroll={onScroll}
          style={{
            height: '60vh',
            minHeight: 240,
            overflowY: 'auto',
            padding: '8px 16px 12px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            // Drag the bottom-right corner to make the terminal taller or shorter.
            resize: 'vertical',
          }}
        >
          {t.items.map((item, i) => (
            <Line key={i} item={item} />
          ))}
          {t.items.length === 0 && !t.streaming && (
            <div style={{ color: TERM.dim, padding: '8px 0 12px' }}>
              <div style={{ color: TERM.fg, fontWeight: 600 }}>New session</div>
              Describe what you want done in this project. pi can read and edit files and run
              commands in the sandbox, and shows each step as it goes.
            </div>
          )}
          {t.streaming && (
            <>
              <Reply text={t.streaming} />
              <span
                style={{
                  animation: 'pp-cursor 1s steps(1) infinite',
                  color: TERM.prompt,
                  marginLeft: 12,
                }}
              >
                ▋
              </span>
            </>
          )}
          {t.running && !t.streaming && (
            <div className="pp-blink" style={{ color: TERM.dim, margin: '6px 0 0 12px' }}>
              ● thinking…
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 6 }}>
            <span style={{ color: TERM.prompt, fontWeight: 600, whiteSpace: 'pre' }}>❯ </span>
            <Textarea
              variant="unstyled"
              autosize
              minRows={1}
              maxRows={8}
              style={{ flex: 1 }}
              aria-label={t.running ? 'Message the running agent' : 'Send a prompt'}
              placeholder={
                t.running
                  ? mode === 'steer'
                    ? 'steer the running agent…'
                    : 'queue a follow-up…'
                  : 'send a prompt…'
              }
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              styles={{
                input: {
                  color: TERM.fg,
                  fontFamily: MONO,
                  fontSize: 13,
                  lineHeight: 1.5,
                  minHeight: 0,
                  padding: 0,
                },
              }}
            />
          </div>
        </div>
        {!following && (
          <Button
            size="compact-xs"
            variant="filled"
            color="gray"
            leftSection={<IconArrowDown size={13} />}
            onClick={jumpToEnd}
            style={{ position: 'absolute', right: 24, bottom: 16 }}
          >
            Latest
          </Button>
        )}
      </div>
      <ErrorText error={error} />
      <Group gap="xs">
        {t.running && (
          <>
            <Tip label="Steer interrupts the current step; a follow-up waits until pi is done">
              <SegmentedControl
                size="xs"
                value={mode}
                onChange={(v) => setMode(v as 'steer' | 'followUp')}
                data={[
                  { value: 'steer', label: 'Steer' },
                  { value: 'followUp', label: 'Follow-up' },
                ]}
              />
            </Tip>
            <Button type="button" size="xs" variant="light" color="red" onClick={stop}>
              Stop
            </Button>
          </>
        )}
        <Text size="xs" c="dimmed">
          Enter sends · Shift+Enter new line · ↑ last prompt{t.running ? ' · Esc stops' : ''}
        </Text>
      </Group>
    </Stack>
  );
}
