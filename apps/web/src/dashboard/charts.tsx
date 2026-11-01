import { Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconArrowDownRight, IconArrowUpRight, IconMinus } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/** One accent hue for every single-series mark; the de-emphasis grey for context. */
const ACCENT = 'var(--mantine-primary-color-filled)';
const MUTED = 'var(--pp-mark-muted)';
const GRID = 'var(--mantine-color-default-border)';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

/** 1,284 below ten thousand, 12.9K above it. */
export const formatCount = (n: number) =>
  Math.abs(n) < 10_000 ? whole.format(n) : compact.format(n);

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "yesterday", or "just now" for anything under a minute. */
export function timeAgo(ms: number, now = Date.now()) {
  const diff = ms - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

/** Parses a YYYY-MM-DD bucket as a local date (not UTC midnight). */
export const localDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/** Rounds up to 1, 2 or 5 times a power of ten, for clean axis maxima. */
export function niceCeil(n: number) {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * p >= n) ?? 10) * p;
}

/**
 * A 2px line of the whole period in grey, with the current period drawn over it in the accent and
 * an end dot on the latest value.
 */
export function Sparkline({
  values,
  current,
  label,
}: {
  values: number[];
  /** How many of the latest values form the current period. */
  current: number;
  label: string;
}) {
  const { ref, width } = useElementSize();
  const height = 36;
  const pad = 5;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const pts = values.map(
    (v, i) => [pad + i * step, height - pad - (v / max) * (height - pad * 2)] as const,
  );
  const path = (from: number) =>
    pts
      .slice(from)
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
  const last = pts.at(-1);
  return (
    <Box ref={ref} h={height} role="img" aria-label={label}>
      {width > 0 && last && (
        <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
          <path
            d={path(0)}
            fill="none"
            stroke={MUTED}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={path(Math.max(0, values.length - current - 1))}
            fill="none"
            stroke={ACCENT}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle
            cx={last[0]}
            cy={last[1]}
            r={4}
            fill={ACCENT}
            stroke="var(--mantine-color-body)"
            strokeWidth={2}
          />
        </svg>
      )}
    </Box>
  );
}

/** Change against the previous period. Activity has no good or bad direction, so it stays neutral. */
export function Delta({ now, before, period }: { now: number; before: number; period: string }) {
  const diff = now - before;
  const Arrow = diff > 0 ? IconArrowUpRight : diff < 0 ? IconArrowDownRight : IconMinus;
  const text =
    before === 0
      ? diff === 0
        ? `No change vs ${period}`
        : `${formatCount(diff)} more than ${period}`
      : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.round((Math.abs(diff) / before) * 100)}% vs ${period}`;
  return (
    <Group gap={4} wrap="nowrap" c="dimmed">
      <Arrow size={14} stroke={1.8} style={{ flexShrink: 0 }} />
      <Text size="xs" c="dimmed" truncate>
        {text}
      </Text>
    </Group>
  );
}

/** Label, a headline number, and an optional line of context and trend. */
export function StatTile({
  value,
  sub,
  trend,
}: {
  value: ReactNode;
  sub?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <Stack gap={4} h="100%" justify="space-between">
      <Stack gap={2}>
        <Text fz={30} fw={650} lh={1.1} style={{ letterSpacing: '-0.02em' }}>
          {value}
        </Text>
        {sub && (
          <Text component="div" size="xs" c="dimmed">
            {sub}
          </Text>
        )}
      </Stack>
      {trend}
    </Stack>
  );
}

export interface Column {
  key: string;
  value: number;
  /** Axis label under the column. */
  tick: string;
  /** Shown on hover and focus, and read by screen readers. */
  detail: string;
}

/**
 * Columns from one baseline, at most 24px wide with 4px rounded caps. The tallest column carries
 * its value; every column shows its detail on hover or keyboard focus.
 */
export function ColumnChart({ columns, unit }: { columns: Column[]; unit: string }) {
  const { ref, width, height } = useElementSize();
  const max = Math.max(0, ...columns.map((c) => c.value));
  const top = niceCeil(max);
  // The latest column holding the maximum gets the direct label.
  let peak = -1;
  if (max > 0)
    columns.forEach((c, i) => {
      if (c.value === max) peak = i;
    });
  const axisW = 30;
  const tickH = 20;
  const plotH = Math.max(0, height - tickH - 18);
  const slot = columns.length ? (width - axisW) / columns.length : 0;
  // Label every column when there is room, otherwise every second or third.
  const every = slot >= 34 ? 1 : slot >= 18 ? 2 : 3;
  const ticks = [0, top / 2, top];

  return (
    <Box ref={ref} h="100%" mih={140} pos="relative" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {width > 0 && (
        <>
          {/* Hairline gridlines with their values, behind the columns. */}
          {ticks.map((t) => {
            const y = 18 + plotH - (t / top) * plotH;
            return (
              <Box key={t} pos="absolute" left={0} right={0} top={y} style={{ height: 0 }}>
                <Box
                  pos="absolute"
                  left={axisW}
                  right={0}
                  top={0}
                  style={{ borderTop: `1px solid ${GRID}` }}
                />
                <Text
                  pos="absolute"
                  left={0}
                  top={-8}
                  w={axisW - 6}
                  ta="right"
                  fz={11}
                  c="dimmed"
                  lh="16px"
                >
                  {formatCount(t)}
                </Text>
              </Box>
            );
          })}
          <Group
            gap={0}
            wrap="nowrap"
            pos="absolute"
            left={axisW}
            right={0}
            top={18}
            h={plotH + tickH}
            align="stretch"
            role="list"
            aria-label={`${unit} per day`}
          >
            {columns.map((c, i) => {
              const h = (c.value / top) * plotH;
              return (
                <Tooltip key={c.key} label={c.detail} withArrow openDelay={0}>
                  <Box
                    role="listitem"
                    tabIndex={0}
                    aria-label={c.detail}
                    className="pp-column"
                    style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
                  >
                    <Box
                      style={{
                        flex: `0 0 ${plotH}px`,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        alignItems: 'center',
                      }}
                    >
                      {i === peak && (
                        <Text fz={11} fw={600} lh="16px" mb={2}>
                          {formatCount(c.value)}
                        </Text>
                      )}
                      {c.value > 0 && (
                        <Box
                          style={{
                            width: 'min(24px, 62%)',
                            height: Math.max(2, h),
                            background: ACCENT,
                            borderRadius: '4px 4px 0 0',
                          }}
                        />
                      )}
                    </Box>
                    <Text fz={11} c="dimmed" ta="center" lh={`${tickH}px`} truncate>
                      {(columns.length - 1 - i) % every === 0 ? c.tick : ''}
                    </Text>
                  </Box>
                </Tooltip>
              );
            })}
          </Group>
        </>
      )}
    </Box>
  );
}

export interface Ranked {
  label: string;
  value: number;
}

/** One bar per item, largest first, from a shared left baseline, with the value at the tip. */
export function RankedBars({ items, unit }: { items: Ranked[]; unit: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <Stack gap={10} role="list" aria-label={unit}>
      {items.map((item) => (
        <Box key={item.label} role="listitem" aria-label={`${item.label}: ${item.value} ${unit}`}>
          <Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
            <Text size="sm" truncate title={item.label}>
              {item.label}
            </Text>
            <Text size="sm" fw={600} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatCount(item.value)}
            </Text>
          </Group>
          <Box h={10} style={{ borderRadius: '0 4px 4px 0' }}>
            <Box
              h={10}
              w={`${Math.max(2, (item.value / max) * 100)}%`}
              style={{ background: ACCENT, borderRadius: '0 4px 4px 0' }}
            />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}
