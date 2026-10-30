import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { abortSession, fetchEvents, openStream, sendPrompt } from './api.js';
import { applyMessage, emptyTranscript, type Transcript } from './transcript.js';
import type { StreamMessage } from './api.js';

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
    <div>
      <div style={{ display: 'grid', gap: 8, margin: '12px 0' }}>
        {t.items.map((item, i) => (
          <div key={i} style={{ whiteSpace: 'pre-wrap', opacity: item.kind === 'tool' ? 0.7 : 1 }}>
            <strong>
              {{ user: 'You', assistant: 'Pi', tool: 'Tool', notice: 'Notice' }[item.kind]}:
            </strong>{' '}
            {item.text}
          </div>
        ))}
        {t.streaming && (
          <div style={{ whiteSpace: 'pre-wrap' }}>
            <strong>Pi:</strong> {t.streaming}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder={t.running ? 'Steer the running agent...' : 'Send a prompt...'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button disabled={!text.trim()}>{t.running ? 'Steer' : 'Send'}</button>
        {t.running && (
          <button
            type="button"
            onClick={() => void abortSession(sessionId).catch((e: Error) => setError(e.message))}
          >
            Stop
          </button>
        )}
      </form>
    </div>
  );
}
