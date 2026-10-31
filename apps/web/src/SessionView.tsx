import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Group, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import { IconArrowDown, IconDownload } from '@tabler/icons-react';
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
};
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
/** Within this many pixels of the bottom counts as "following" the output. */
const STICKY_PX = 48;

function ToolLine({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const mark = item.state === 'running' ? '…' : item.state === 'failed' ? '✗' : '✓';
  const color = item.state === 'failed' ? TERM.bad : item.state === 'done' ? TERM.ok : TERM.tool;
  const expandable = !!item.output;
  return (
    <div>
      <div
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen(!open)}
        onKeyDown={(e) => expandable && e.key === 'Enter' && setOpen(!open)}
        style={{ color: TERM.tool, cursor: expandable ? 'pointer' : 'default' }}
      >
        {'  '}
        <span style={{ color }}>{mark}</span> {item.text}
        {expandable && <span style={{ color: TERM.dim }}>{open ? '  ▾' : '  ▸'}</span>}
      </div>
      {open && (
        <div
          style={{
            color: TERM.dim,
            borderLeft: `2px solid ${TERM.border}`,
            margin: '2px 0 4px 10px',
            paddingLeft: 10,
            maxHeight: 320,
            overflowY: 'auto',
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
        <div style={{ color: TERM.fg, fontWeight: 600 }}>
          <span style={{ color: TERM.prompt }}>❯ </span>
          {item.text}
        </div>
      );
    case 'tool':
      return <ToolLine item={item} />;
    case 'notice':
      return <div style={{ color: TERM.warn }}>{`  ⚠ ${item.text}`}</div>;
    case 'error':
      return <div style={{ color: TERM.bad }}>{`  ✗ ${item.text}`}</div>;
    default:
      return <div style={{ color: TERM.fg }}>{item.text}</div>;
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
      <style>{'@keyframes pp-cursor { 50% { opacity: 0; } }'}</style>
      <div
        style={{
          background: TERM.bg,
          border: `1px solid ${TERM.border}`,
          borderRadius: 10,
          overflow: 'hidden',
          fontFamily: MONO,
          fontSize: 13,
          lineHeight: 1.5,
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
          <span style={{ marginLeft: 8, flex: 1 }}>pi {t.running ? '· working…' : ''}</span>
          <Tip label="Save the transcript as Markdown">
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={<IconDownload size={13} />}
              disabled={t.items.length === 0}
              styles={{ root: { color: TERM.fg } }}
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
            padding: '12px 16px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            // Drag the bottom-right corner to make the terminal taller or shorter.
            resize: 'vertical',
          }}
        >
          {t.items.map((item, i) => (
            <Line key={i} item={item} />
          ))}
          {t.streaming && (
            <div style={{ color: TERM.fg }}>
              {t.streaming}
              <span style={{ animation: 'pp-cursor 1s steps(1) infinite' }}>▋</span>
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
