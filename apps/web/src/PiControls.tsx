import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Popover,
  Progress,
  Select,
  Switch,
  Text,
  Textarea,
} from '@mantine/core';
import {
  compactSession,
  getPiState,
  setAutoCompaction,
  setThinkingLevel,
  type PiState,
} from './api.js';
import { ErrorText, Tip } from './ui.js';

/** Offered while pi is not running, when it cannot yet say which levels the model supports. */
const FALLBACK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

const compact = (n: number | null | undefined) =>
  n == null
    ? '?'
    : n >= 1_000_000
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);

/**
 * pi's own controls for a session: how hard it thinks, how full its context is, and compaction.
 * Reads from pi while it runs and refreshes when a turn ends, so the numbers move with the work.
 */
export function PiControls({ sessionId, working }: { sessionId: number; working: boolean }) {
  const [state, setState] = useState<PiState | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [open, setOpen] = useState(false);
  const alive = useRef(true);

  const refresh = () =>
    getPiState(sessionId).then(
      (s) => alive.current && setState(s),
      () => undefined,
    );

  useEffect(() => {
    alive.current = true;
    setState(null);
    setNote('');
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 20_000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  // A turn starting or ending changes the numbers.
  useEffect(() => {
    void refresh();
  }, [working]);

  if (!state) return null;

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const levels = state.availableThinkingLevels.length
    ? state.availableThinkingLevels
    : FALLBACK_LEVELS;
  const ctx = state.stats?.context;
  const ctxWindow = ctx?.window ?? state.model?.contextWindow ?? null;
  const percent =
    ctx?.percent ?? (ctx?.tokens != null && ctxWindow ? (ctx.tokens / ctxWindow) * 100 : null);
  const tokens = state.stats?.tokens;

  return (
    <Group gap="md" wrap="wrap" align="center">
      <Tip
        label={
          tokens
            ? `Input ${compact(tokens.input)} · output ${compact(tokens.output)} · cache read ${compact(tokens.cacheRead)} · cache write ${compact(tokens.cacheWrite)} · cost $${(state.stats?.cost ?? 0).toFixed(2)} · ${state.stats?.toolCalls ?? 0} tool calls`
            : 'Token use appears once the session is running'
        }
      >
        <Group gap={8} wrap="nowrap" miw={200}>
          <Progress
            value={Math.min(100, percent ?? 0)}
            w={120}
            size="sm"
            color={
              percent != null && percent >= 85
                ? 'red'
                : percent != null && percent >= 65
                  ? 'yellow'
                  : 'teal'
            }
          />
          <Text size="xs" c="dimmed">
            {ctx?.tokens != null
              ? `${compact(ctx.tokens)}${ctxWindow ? ` / ${compact(ctxWindow)}` : ''} context${percent != null ? ` (${Math.round(percent)}%)` : ''}`
              : 'context not started'}
          </Text>
        </Group>
      </Tip>
      {tokens && (
        <Text size="xs" c="dimmed">
          {compact(tokens.total)} tokens · ${(state.stats?.cost ?? 0).toFixed(2)}
        </Text>
      )}

      <Tip
        label={
          state.running
            ? 'How hard the model thinks before answering. Models without reasoning only offer off.'
            : 'Applies when the session starts'
        }
      >
        <Select
          aria-label="Thinking level"
          size="xs"
          w={130}
          allowDeselect={false}
          data={levels.map((l) => ({ value: l, label: `Thinking: ${l}` }))}
          value={state.thinkingLevel ?? null}
          placeholder="Thinking"
          disabled={busy}
          onChange={(level) =>
            level &&
            void act(async () => {
              setState(await setThinkingLevel(sessionId, level));
            })
          }
        />
      </Tip>

      <Tip label="When the context is nearly full, pi summarises older messages by itself">
        <Switch
          size="xs"
          label="Auto-compact"
          checked={state.autoCompaction ?? true}
          disabled={busy}
          onChange={(e) => {
            const enabled = e.currentTarget.checked;
            void act(async () => {
              setState(await setAutoCompaction(sessionId, enabled));
            });
          }}
        />
      </Tip>

      <Popover opened={open} onChange={setOpen} position="top" withArrow width={320}>
        <Popover.Target>
          <Button
            size="compact-xs"
            variant="default"
            disabled={!state.running || working || busy}
            loading={busy && open}
            onClick={() => setOpen((o) => !o)}
          >
            Compact now
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Text size="xs" c="dimmed" mb={6}>
            Summarises older messages to free context. This is a model call and can take a minute.
          </Text>
          <Textarea
            size="xs"
            autosize
            minRows={2}
            placeholder="What to keep (optional), e.g. focus on the code changes"
            value={instructions}
            onChange={(e) => setInstructions(e.currentTarget.value)}
          />
          <Group justify="flex-end" mt={8}>
            <Button
              size="xs"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  const r = await compactSession(sessionId, instructions.trim() || undefined);
                  setNote(
                    r.tokensBefore != null && r.tokensAfter != null
                      ? `Compacted: ${compact(r.tokensBefore)} → about ${compact(r.tokensAfter)} tokens`
                      : 'Compacted',
                  );
                  setOpen(false);
                  setInstructions('');
                  await refresh();
                })
              }
            >
              Compact
            </Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
      {state.isCompacting && (
        <Badge variant="light" color="yellow">
          compacting
        </Badge>
      )}
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
      <ErrorText error={error} />
    </Group>
  );
}
