import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { abortSession, fetchEvents, openStream, sendPrompt } from './api.js';
import { applyMessage, emptyTranscript, type Transcript } from './transcript.js';
import type { StreamMessage } from './api.js';
import { ErrorText } from './ui.js';

// A terminal looks the same in light and dark mode, so these colours are fixed.
const TERM = {
  bg: '#0b0f14',
  bar: '#161b22',
  fg: '#d6dde6',
  dim: '#6b7785',
  prompt: '#4fd1c5',
  tool: '#8b9bb4',
  warn: '#e3b341',
  border: '#2a313c',
};
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** How each kind of transcript line reads in the terminal. */
function Line({ kind, text }: { kind: string; text: string }) {
  if (kind === 'user') {
    return (
      <div style={{ color: TERM.fg, fontWeight: 600 }}>
        <span style={{ color: TERM.prompt }}>❯ </span>
        {text}
      </div>
    );
  }
  if (kind === 'tool') {
    return <div style={{ color: TERM.tool }}>{`  ⚙ ${text}`}</div>;
  }
  if (kind === 'notice') {
    return <div style={{ color: TERM.warn }}>{`  ⚠ ${text}`}</div>;
  }
  return <div style={{ color: TERM.fg }}>{text}</div>;
}

export function SessionView({ sessionId }: { sessionId: number }) {
  const [t, push] = useReducer(
    (state: Transcript, m: StreamMessage | 'reset') =>
      m === 'reset' ? emptyTranscript : applyMessage(state, m),
    emptyTranscript,
  );
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const lastSeq = useRef(0);
  const screen = useRef<HTMLDivElement>(null);
  lastSeq.current = t.lastSeq;

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
          if (page.length === 0 || page.length < 1000) break;
          lastSeq.current = page[page.length - 1]!.seq;
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

  // Keep the newest output in view, as a terminal does.
  useEffect(() => {
    const el = screen.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [t.items.length, t.streaming]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setError('');
    try {
      await sendPrompt(sessionId, message, t.running ? 'steer' : undefined);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
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
          <span style={{ marginLeft: 8 }}>pi {t.running ? '· working…' : ''}</span>
        </div>
        <div
          ref={screen}
          style={{ height: 460, overflowY: 'auto', padding: '12px 16px', whiteSpace: 'pre-wrap' }}
        >
          {t.items.map((item, i) => (
            <Line key={i} kind={item.kind} text={item.text} />
          ))}
          {t.streaming && (
            <div style={{ color: TERM.fg }}>
              {t.streaming}
              <span style={{ animation: 'pp-cursor 1s steps(1) infinite' }}>▋</span>
            </div>
          )}
          <form onSubmit={submit} style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
            <span style={{ color: TERM.prompt, fontWeight: 600, whiteSpace: 'pre' }}>❯ </span>
            <TextInput
              variant="unstyled"
              style={{ flex: 1 }}
              aria-label={t.running ? 'Steer the running agent' : 'Send a prompt'}
              placeholder={t.running ? 'steer the running agent…' : 'send a prompt…'}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              styles={{
                input: {
                  color: TERM.fg,
                  fontFamily: MONO,
                  fontSize: 13,
                  minHeight: 0,
                  height: 'auto',
                  padding: 0,
                },
              }}
            />
          </form>
        </div>
      </div>
      <ErrorText error={error} />
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          Enter sends{t.running ? ' a steering message' : ' a prompt'}.
        </Text>
        {t.running && (
          <Button
            type="button"
            variant="light"
            color="red"
            onClick={() => void abortSession(sessionId).catch((e: Error) => setError(e.message))}
          >
            Stop
          </Button>
        )}
      </Group>
    </Stack>
  );
}
