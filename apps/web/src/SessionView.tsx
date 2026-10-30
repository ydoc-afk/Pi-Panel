import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { Button, Group, Paper, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { abortSession, fetchEvents, openStream, sendPrompt } from './api.js';
import { applyMessage, emptyTranscript, type Transcript } from './transcript.js';
import type { StreamMessage } from './api.js';
import { ErrorText } from './ui.js';

const LABEL = { user: 'You', assistant: 'Pi', tool: 'Tool', notice: 'Notice' } as const;
const COLOR = { user: 'teal', assistant: 'dark', tool: 'dimmed', notice: 'orange' } as const;

export function SessionView({ sessionId }: { sessionId: number }) {
  const [t, push] = useReducer(
    (state: Transcript, m: StreamMessage | 'reset') =>
      m === 'reset' ? emptyTranscript : applyMessage(state, m),
    emptyTranscript,
  );
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const lastSeq = useRef(0);
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
      <Paper withBorder radius="md" p="md">
        <ScrollArea h={420} type="auto" offsetScrollbars>
          <Stack gap="xs">
            {t.items.map((item, i) => (
              <Text key={i} size="sm" c={COLOR[item.kind]} style={{ whiteSpace: 'pre-wrap' }}>
                <Text span fw={700} inherit>
                  {LABEL[item.kind]}:
                </Text>{' '}
                {item.text}
              </Text>
            ))}
            {t.streaming && (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                <Text span fw={700} inherit>
                  Pi:
                </Text>{' '}
                {t.streaming}
              </Text>
            )}
          </Stack>
        </ScrollArea>
      </Paper>
      <ErrorText error={error} />
      <form onSubmit={submit}>
        <Group gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder={t.running ? 'Steer the running agent...' : 'Send a prompt...'}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          <Button type="submit" disabled={!text.trim()}>
            {t.running ? 'Steer' : 'Send'}
          </Button>
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
      </form>
    </Stack>
  );
}
