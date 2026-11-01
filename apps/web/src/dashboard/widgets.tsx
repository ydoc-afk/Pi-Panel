import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Card,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconGripVertical,
  IconX,
  type Icon,
} from '@tabler/icons-react';
import type { DashboardData } from '../api.js';
import { StatusBadge } from '../ui.js';
import {
  ColumnChart,
  Delta,
  RankedBars,
  Sparkline,
  StatTile,
  formatCount,
  localDate,
  timeAgo,
} from './charts.js';
import { WIDGETS, type WidgetId } from './layout.js';

/** Where a widget can send the viewer. */
export interface DashboardNav {
  openProject: (projectId: number, sessionId?: number) => void;
  goTo: (tab: 'projects' | 'providers' | 'mcp' | 'github' | 'forgejo' | 'users') => void;
}

export interface WidgetContext {
  data: DashboardData;
  nav: DashboardNav;
  isAdmin: boolean;
}

/** The frame every widget sits in. In edit mode its title bar is the drag handle. */
export function WidgetCard({
  id,
  editing,
  onRemove,
  action,
  children,
}: {
  id: WidgetId;
  editing: boolean;
  onRemove: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const meta = WIDGETS[id];
  return (
    <Card
      padding="md"
      h="100%"
      className={editing ? 'pp-widget pp-widget-editing' : 'pp-widget'}
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <Group
        justify="space-between"
        wrap="nowrap"
        gap="xs"
        mb="sm"
        className={editing ? 'pp-drag-handle' : undefined}
        style={{ flex: '0 0 auto', minHeight: 26 }}
      >
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          {editing && (
            <IconGripVertical
              size={16}
              stroke={1.6}
              style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }}
            />
          )}
          <Tooltip label={meta.description} openDelay={500} withArrow>
            <Text size="sm" fw={600} truncate>
              {meta.title}
            </Text>
          </Tooltip>
        </Group>
        <Group gap={4} wrap="nowrap" className="pp-no-drag">
          {!editing && action}
          {editing && (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Remove ${meta.title}`}
              onClick={onRemove}
            >
              <IconX size={14} />
            </ActionIcon>
          )}
        </Group>
      </Group>
      <Box style={{ flex: '1 1 auto', minHeight: 0 }}>{children}</Box>
    </Card>
  );
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/** A 7-day total with the change against the 7 days before and a two-week trend line. */
function WeekTile({ values, noun }: { values: number[]; noun: string }) {
  const half = Math.floor(values.length / 2);
  const current = sum(values.slice(half));
  const before = sum(values.slice(0, half));
  return (
    <StatTile
      value={formatCount(current)}
      sub={<Delta now={current} before={before} period="prior 7 days" />}
      trend={
        <Sparkline
          values={values}
          current={values.length - half}
          label={`${noun} per day for 14 days, ${current} in the last 7`}
        />
      }
    />
  );
}

type Metric = 'prompts' | 'toolCalls' | 'errors';
const METRICS: { value: Metric; label: string; unit: string }[] = [
  { value: 'prompts', label: 'Prompts', unit: 'prompt' },
  { value: 'toolCalls', label: 'Tool calls', unit: 'tool call' },
  { value: 'errors', label: 'Failures', unit: 'failure' },
];

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** One metric per day; the control switches which, so two scales never share an axis. */
function ActivityWidget({ ctx, editing, onRemove }: WidgetProps) {
  const [metric, setMetric] = useState<Metric>('prompts');
  const m = METRICS.find((x) => x.value === metric)!;
  const days = ctx.data.activity.days;
  const columns = days.map((d, i) => {
    const date = localDate(d.date);
    const today = i === days.length - 1;
    return {
      key: d.date,
      value: d[metric],
      tick: today ? 'Today' : String(date.getDate()),
      detail: `${today ? 'Today' : dayLabel.format(date)}: ${plural(d[metric], m.unit)}`,
    };
  });
  return (
    <WidgetCard
      id="activity"
      editing={editing}
      onRemove={onRemove}
      action={
        <SegmentedControl
          size="xs"
          aria-label="Activity measure"
          value={metric}
          onChange={(v) => setMetric(v as Metric)}
          data={METRICS.map(({ value, label }) => ({ value, label }))}
        />
      }
    >
      <Stack h="100%" gap={6}>
        <Text size="xs" c="dimmed">
          {m.label} per day, last 14 days · {plural(sum(columns.map((c) => c.value)), m.unit)}
        </Text>
        <Box style={{ flex: 1, minHeight: 0 }}>
          <ColumnChart columns={columns} unit={m.label} />
        </Box>
      </Stack>
    </WidgetCard>
  );
}

type Level = 'ok' | 'warning' | 'critical' | 'off';
const LEVEL: Record<Level, { color: string; icon: Icon; word: string }> = {
  ok: { color: 'green', icon: IconCircleCheck, word: 'OK' },
  warning: { color: 'yellow', icon: IconAlertTriangle, word: 'Attention' },
  critical: { color: 'red', icon: IconCircleX, word: 'Problem' },
  off: { color: 'gray', icon: IconCircleDashed, word: 'Not set up' },
};

interface Check {
  label: string;
  level: Level;
  detail: string;
  open?: () => void;
}

function healthChecks({ data: d, nav, isAdmin }: WidgetContext): Check[] {
  const admin = (tab: Parameters<DashboardNav['goTo']>[0]) =>
    isAdmin ? () => nav.goTo(tab) : undefined;
  const checks: Check[] = [
    {
      label: 'Sandbox image',
      level: d.sandbox.available ? 'ok' : 'critical',
      detail: d.sandbox.available ? 'Built and ready' : 'Not built yet, projects cannot start',
      open: d.sandbox.available ? undefined : () => nav.goTo('projects'),
    },
    {
      label: 'Providers',
      level: d.providers.total === 0 ? 'warning' : d.providers.warnings > 0 ? 'warning' : 'ok',
      detail:
        d.providers.total === 0
          ? 'No model provider yet'
          : `${plural(d.providers.total, 'provider')}, ${plural(d.providers.models, 'model')}` +
            (d.providers.warnings ? `, ${plural(d.providers.warnings, 'warning')}` : ''),
      open: admin('providers'),
    },
    {
      label: 'GitHub',
      level: d.github.connected ? 'ok' : 'off',
      detail: d.github.connected ? `Connected as ${d.github.login}` : 'Not connected',
      open: admin('github'),
    },
    {
      label: 'Forgejo',
      level: d.forgejo.connected ? 'ok' : 'off',
      detail: d.forgejo.connected ? `Connected as ${d.forgejo.login}` : 'Not connected',
      open: admin('forgejo'),
    },
    {
      label: 'MCP servers',
      level: d.mcp.total === 0 ? 'off' : d.mcp.failing > 0 ? 'warning' : 'ok',
      detail:
        d.mcp.total === 0
          ? 'No servers in the library'
          : `${d.mcp.connected} of ${d.mcp.total} connected` +
            (d.mcp.failing ? `, ${d.mcp.failing} failing` : '') +
            (d.mcp.untested ? `, ${d.mcp.untested} not tested` : ''),
      open: admin('mcp'),
    },
    {
      label: 'Sessions',
      level: d.sessions.errored > 0 ? 'critical' : 'ok',
      detail:
        d.sessions.errored > 0
          ? `${plural(d.sessions.errored, 'session')} in an error state`
          : d.sessions.running > 0
            ? `${formatCount(d.sessions.running)} running now`
            : 'All idle',
    },
  ];
  if (d.users) {
    checks.push({
      label: 'Accounts',
      level: d.users.pending > 0 ? 'warning' : 'ok',
      detail:
        d.users.pending > 0
          ? `${formatCount(d.users.pending)} waiting for approval`
          : plural(d.users.total, 'account'),
      open: admin('users'),
    });
  }
  return checks;
}

function HealthWidget({ ctx, editing, onRemove }: WidgetProps) {
  const checks = healthChecks(ctx);
  return (
    <WidgetCard id="health" editing={editing} onRemove={onRemove}>
      <ScrollArea h="100%" type="auto" offsetScrollbars>
        <Stack gap={4}>
          {checks.map((c) => {
            const lv = LEVEL[c.level];
            return (
              <Group key={c.label} gap="sm" wrap="nowrap" py={6} align="flex-start">
                <ThemeIcon variant="light" color={lv.color} size={30} radius="md">
                  <lv.icon size={18} stroke={1.7} />
                </ThemeIcon>
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={6} wrap="nowrap" justify="space-between">
                    <Text size="sm" fw={600} truncate>
                      {c.label}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {lv.word}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {c.detail}
                    {c.open && (
                      <>
                        {' · '}
                        <Anchor component="button" type="button" size="xs" onClick={c.open}>
                          Open
                        </Anchor>
                      </>
                    )}
                  </Text>
                </Stack>
              </Group>
            );
          })}
        </Stack>
      </ScrollArea>
    </WidgetCard>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Stack h="100%" justify="center" align="center">
      <Text size="sm" c="dimmed" ta="center" maw={280}>
        {children}
      </Text>
    </Stack>
  );
}

function RecentWidget({ ctx, editing, onRemove }: WidgetProps) {
  const recent = ctx.data.sessions.recent;
  return (
    <WidgetCard id="recent" editing={editing} onRemove={onRemove}>
      {recent.length === 0 ? (
        <Empty>No sessions yet. Open a project and start one.</Empty>
      ) : (
        <ScrollArea h="100%" type="auto" offsetScrollbars>
          <Stack gap={2}>
            {recent.map((s) => (
              <UnstyledButton
                key={s.id}
                className="pp-row"
                onClick={() => ctx.nav.openProject(s.projectId, s.id)}
                aria-label={`Open ${s.name} in ${s.projectName}`}
              >
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Group gap={8} wrap="nowrap">
                      <Text size="sm" fw={600} truncate>
                        {s.name}
                      </Text>
                      {s.status !== 'idle' && <StatusBadge status={s.status} />}
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {s.projectName} · {s.modelId ?? 'pi default model'}
                    </Text>
                  </Stack>
                  <Stack gap={0} align="flex-end" style={{ flexShrink: 0 }}>
                    <Text size="xs" c="dimmed">
                      {s.lastActivityAt
                        ? timeAgo(s.lastActivityAt)
                        : `created ${timeAgo(s.createdAt)}`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {plural(s.prompts, 'prompt')}
                    </Text>
                  </Stack>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </ScrollArea>
      )}
    </WidgetCard>
  );
}

function ModelUsageWidget({ ctx, editing, onRemove }: WidgetProps) {
  const models = ctx.data.models;
  return (
    <WidgetCard id="modelUsage" editing={editing} onRemove={onRemove}>
      {models.length === 0 ? (
        <Empty>Sessions you start will show their model here.</Empty>
      ) : (
        <ScrollArea h="100%" type="auto" offsetScrollbars>
          <RankedBars
            unit="sessions"
            items={models.map((m) => ({ label: m.model, value: m.sessions }))}
          />
        </ScrollArea>
      )}
    </WidgetCard>
  );
}

function TopToolsWidget({ ctx, editing, onRemove }: WidgetProps) {
  const tools = ctx.data.tools;
  return (
    <WidgetCard id="topTools" editing={editing} onRemove={onRemove}>
      {tools.length === 0 ? (
        <Empty>No tool calls in the last 14 days.</Empty>
      ) : (
        <ScrollArea h="100%" type="auto" offsetScrollbars>
          <RankedBars unit="calls" items={tools.map((t) => ({ label: t.name, value: t.calls }))} />
        </ScrollArea>
      )}
    </WidgetCard>
  );
}

function ProjectTableWidget({ ctx, editing, onRemove }: WidgetProps) {
  const projects = ctx.data.projects.items;
  return (
    <WidgetCard id="projectTable" editing={editing} onRemove={onRemove}>
      {projects.length === 0 ? (
        <Empty>
          No projects yet.{' '}
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => ctx.nav.goTo('projects')}
          >
            Create one
          </Anchor>
        </Empty>
      ) : (
        <ScrollArea h="100%" type="auto">
          <Table
            highlightOnHover
            verticalSpacing={6}
            style={{ fontVariantNumeric: 'tabular-nums' }}
            miw={560}
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Project</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th ta="right">Sessions</Table.Th>
                <Table.Th ta="right">Prompts, 14 days</Table.Th>
                <Table.Th>Last active</Table.Th>
                <Table.Th>Repository</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {projects.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    <Anchor
                      component="button"
                      type="button"
                      size="sm"
                      fw={600}
                      onClick={() => ctx.nav.openProject(p.id)}
                    >
                      {p.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={p.status} />
                  </Table.Td>
                  <Table.Td ta="right">
                    {formatCount(p.sessions)}
                    {p.runningSessions > 0 && (
                      <Badge ml={6} size="xs" variant="light" color="green" tt="none">
                        {p.runningSessions} running
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">{formatCount(p.prompts)}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {p.lastActivityAt ? timeAgo(p.lastActivityAt) : 'No recent activity'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" truncate maw={220}>
                      {p.repo ?? '—'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </WidgetCard>
  );
}

interface WidgetProps {
  ctx: WidgetContext;
  editing: boolean;
  onRemove: () => void;
}

function tile(id: WidgetId, body: (ctx: WidgetContext) => ReactNode) {
  return function Tile({ ctx, editing, onRemove }: WidgetProps) {
    return (
      <WidgetCard id={id} editing={editing} onRemove={onRemove}>
        {body(ctx)}
      </WidgetCard>
    );
  };
}

const days = (ctx: WidgetContext) => ctx.data.activity.days;

/** Every widget the dashboard can show, by id. */
export const WIDGET_COMPONENTS: Record<WidgetId, (props: WidgetProps) => ReactNode> = {
  prompts: tile('prompts', (ctx) => (
    <WeekTile values={days(ctx).map((d) => d.prompts)} noun="Prompts" />
  )),
  toolCalls: tile('toolCalls', (ctx) => (
    <WeekTile values={days(ctx).map((d) => d.toolCalls)} noun="Tool calls" />
  )),
  errors: tile('errors', (ctx) => (
    <WeekTile values={days(ctx).map((d) => d.errors)} noun="Failures" />
  )),
  sessions: tile('sessions', ({ data: d }) => (
    <StatTile
      value={formatCount(d.sessions.total)}
      sub={
        d.sessions.errored > 0
          ? `${formatCount(d.sessions.running)} running, ${formatCount(d.sessions.errored)} with errors`
          : `${formatCount(d.sessions.running)} running now`
      }
    />
  )),
  projects: tile('projects', ({ data: d }) => (
    <StatTile
      value={formatCount(d.projects.total)}
      sub={`${formatCount(d.projects.running)} of ${formatCount(d.projects.total)} containers up`}
    />
  )),
  models: tile('models', ({ data: d }) => (
    <StatTile
      value={formatCount(d.providers.models)}
      sub={`from ${plural(d.providers.total, 'provider')}`}
    />
  )),
  mcpTools: tile('mcpTools', ({ data: d }) => (
    <StatTile
      value={formatCount(d.mcp.tools)}
      sub={`${d.mcp.connected} of ${plural(d.mcp.total, 'server')} connected`}
    />
  )),
  activity: ActivityWidget,
  health: HealthWidget,
  recent: RecentWidget,
  modelUsage: ModelUsageWidget,
  topTools: TopToolsWidget,
  projectTable: ProjectTableWidget,
};
