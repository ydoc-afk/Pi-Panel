import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Grid,
  Group,
  List,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconCheck,
  IconCloudDownload,
  IconDatabase,
  IconGitBranch,
  IconGitCommit,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import {
  applyUpdate,
  checkUpdates,
  getRunningPanel,
  getUpdateJob,
  getUpdateStatus,
  panelHealthy,
  rollbackUpdate,
  type RunningPanel,
  type UpdateChannel,
  type UpdateJob,
  type UpdaterStatus,
} from './api.js';
import { timeAgo } from './dashboard/charts.js';
import { ErrorText, PageHeader, Tip } from './ui.js';

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown');

/** How each channel is described. Branches outside this list are shown by name. */
const CHANNEL: Record<string, { label: string; color: string; about: string }> = {
  main: {
    label: 'Stable',
    color: 'teal',
    about: 'Promoted from nightly once tried. For the panel you rely on.',
  },
  nightly: {
    label: 'Nightly',
    color: 'violet',
    about: 'Where new work lands first. For a test instance beside your stable panel.',
  },
};
const channelLabel = (b: string) => CHANNEL[b]?.label ?? b;

const PHASES: { id: string; label: string }[] = [
  { id: 'checkout', label: 'Move the checkout to the new commit' },
  { id: 'build', label: 'Build the new version (this panel keeps running)' },
  { id: 'backup', label: 'Stop the panel, back up the database and secret.key' },
  { id: 'restart', label: 'Start the new version' },
  { id: 'health', label: 'Wait for it to answer' },
];

const JOB_STATUS: Record<UpdateJob['status'], { color: string; label: string }> = {
  running: { color: 'blue', label: 'Running' },
  succeeded: { color: 'green', label: 'Succeeded' },
  failed: { color: 'red', label: 'Failed' },
  'rolled-back': { color: 'orange', label: 'Rolled back' },
};

function CommitLine({ c, webUrl }: { c: UpdaterStatus['head']; webUrl: string | null }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <IconGitCommit size={16} stroke={1.6} style={{ flexShrink: 0, marginTop: 3 }} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" fw={500} lineClamp={2}>
          {c.subject}
        </Text>
        <Text size="xs" c="dimmed">
          {webUrl ? (
            <Anchor href={`${webUrl}/commit/${c.sha}`} target="_blank" rel="noreferrer" size="xs">
              {short(c.sha)}
            </Anchor>
          ) : (
            short(c.sha)
          )}{' '}
          · {c.author} · {c.date ? timeAgo(Date.parse(c.date)) : ''}
        </Text>
      </Stack>
    </Group>
  );
}

/** The steps of a running or finished job, its log, and what to do next. */
function JobCard({
  job,
  restarting,
  onRollback,
  busy,
}: {
  job: UpdateJob;
  restarting: boolean;
  onRollback: () => void;
  busy: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.log.length]);
  const s = JOB_STATUS[job.status];
  const phases = job.kind === 'rollback' ? [] : PHASES;
  const at = phases.findIndex((p) => p.id === job.phase);
  const done = job.status === 'succeeded' ? phases.length : at;
  const what =
    job.kind === 'rollback'
      ? 'Roll back'
      : job.kind === 'switch'
        ? `Switch to ${channelLabel(job.to.branch)}`
        : 'Update';
  const title = job.status === 'running' ? what : `Last change: ${what.toLowerCase()}`;
  return (
    <Card padding="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Group gap="sm">
            <Text fw={650}>{title}</Text>
            <Badge variant="light" color={s.color} tt="none">
              {s.label}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            {short(job.from.sha)} → {short(job.to.sha)} · started {timeAgo(job.startedAt)}
          </Text>
        </Group>
        {restarting && (
          <Alert variant="light" color="blue" icon={<Loader size={16} />} radius="md">
            The panel is restarting. This page reconnects by itself.
          </Alert>
        )}
        {job.error && (
          <Alert
            variant="light"
            color={job.status === 'rolled-back' ? 'orange' : 'red'}
            icon={<IconAlertTriangle size={18} />}
            radius="md"
            title={
              job.status === 'rolled-back' ? 'The update did not work, so it was undone' : 'Failed'
            }
          >
            {job.error}
            {job.status === 'rolled-back' && ' The previous version is running again.'}
          </Alert>
        )}
        {phases.length > 0 && (
          <Timeline active={done} bulletSize={22} lineWidth={2}>
            {phases.map((p, i) => (
              <Timeline.Item
                key={p.id}
                bullet={
                  i < done ? (
                    <IconCheck size={12} />
                  ) : i === at && job.status === 'running' ? (
                    <Loader size={12} color="white" />
                  ) : i === at && job.status !== 'succeeded' ? (
                    <IconX size={12} />
                  ) : null
                }
                title={<Text size="sm">{p.label}</Text>}
              />
            ))}
          </Timeline>
        )}
        <ScrollArea.Autosize mah={260} viewportRef={logRef} type="auto">
          <Code block style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {job.log.join('\n') || '(waiting for output)'}
          </Code>
        </ScrollArea.Autosize>
        {job.backup && (
          <Group gap={6} c="dimmed">
            <IconDatabase size={14} />
            <Text size="xs" c="dimmed">
              Database backup: <Code>{job.backup}</Code>
            </Text>
          </Group>
        )}
        {job.status === 'succeeded' && job.kind !== 'rollback' && (
          <Group>
            <Tip
              label={
                job.to.schema !== job.from.schema
                  ? 'Puts back the previous version and restores the database backup, so changes made since the update are lost'
                  : 'Puts back the previous version. Data is kept: the database schema did not change.'
              }
            >
              <Button
                variant="default"
                leftSection={<IconArrowBackUp size={16} />}
                loading={busy}
                onClick={onRollback}
              >
                Roll back to {short(job.from.sha)}
              </Button>
            </Tip>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

/** New commits on the checkout's own channel, for the badge in the sidebar. */
const behindOf = (s: UpdaterStatus) => (s.channel ? (s.remotes[s.channel]?.behind ?? 0) : 0);

export function Updates({ onBehind }: { onBehind?: (n: number) => void } = {}) {
  const [running, setRunning] = useState<RunningPanel | null>(null);
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirm, setConfirm] = useState<{ branch: string; ch: UpdateChannel } | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [reload, setReload] = useState(false);
  const startCommit = useRef<string | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await getRunningPanel();
      setRunning(r);
      if (startCommit.current === undefined) startCommit.current = r.commit;
      // A different commit than when this page loaded means the browser has old code.
      if (startCommit.current !== r.commit) setReload(true);
      if (!r.configured) return;
      const s = await getUpdateStatus();
      setStatus(s);
      setJob(s.job);
      onBehind?.(behindOf(s));
      setStatusError('');
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'Could not reach the updater');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Follows a running job. When the panel goes away mid-update, waits for it to come back.
  useEffect(() => {
    if (job?.status !== 'running') return;
    let stop = false;
    let lines = job.log.length;
    const tick = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const { job: next } = await getUpdateJob(lines);
          setRestarting(false);
          if (!next) continue;
          lines = next.logLength;
          setJob((cur) =>
            cur && cur.id === next.id
              ? { ...next, log: [...cur.log, ...next.log] }
              : { ...next, log: next.log },
          );
          if (next.status !== 'running') {
            await load();
            return;
          }
        } catch {
          setRestarting(true);
          // Wait for the health check rather than hammering a panel that is starting.
          while (!stop && !(await panelHealthy())) await new Promise((r) => setTimeout(r, 2000));
          // Restarting replaced the log offsets' source; fetch the whole job again.
          lines = 0;
          setJob((cur) => (cur ? { ...cur, log: [] } : cur));
        }
      }
    };
    void tick();
    return () => {
      stop = true;
    };
    // Only (re)start following when a different job starts running.
  }, [job?.id, job?.status === 'running']);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setChecking(true);
    setError('');
    try {
      const s = await checkUpdates();
      setStatus(s);
      setJob(s.job);
      onBehind?.(behindOf(s));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  }

  const header = (
    <PageHeader
      icon={IconCloudDownload}
      title="Updates"
      description="Move this panel to the newest commit of its channel. The new version is built while this one keeps running; the database is backed up before the restart, and a version that does not start is undone on its own."
      action={
        status && (
          <Group gap="xs">
            {status.checkedAt && (
              <Text size="xs" c="dimmed">
                Checked {timeAgo(status.checkedAt)}
              </Text>
            )}
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              loading={checking}
              disabled={job?.status === 'running'}
              onClick={() => void check()}
            >
              Check now
            </Button>
          </Group>
        )
      }
    />
  );

  if (!running) {
    return (
      <Stack gap="lg">
        {header}
        {statusError ? <ErrorText error={statusError} /> : <Loader size="sm" />}
      </Stack>
    );
  }

  if (!running.configured) {
    return (
      <Stack gap="lg">
        {header}
        <Alert
          variant="light"
          radius="lg"
          icon={<IconCloudDownload size={18} />}
          title="The updater is not set up"
        >
          <Text size="sm">
            Updates from this page are done by the <Code>updater</Code> service in{' '}
            <Code>docker-compose.yml</Code>. From the repository root on the host, run this once:
          </Text>
          <Code block mt="xs">
            git pull{'\n'}docker compose up -d --build
          </Code>
          <Text size="sm" mt="xs">
            Keep settings you pass to compose in <Code>.env</Code> rather than the shell, so the
            updater can reproduce them. This panel is running commit {short(running.commit)},
            database schema {running.schema}.
          </Text>
        </Alert>
      </Stack>
    );
  }

  const jobCard = job && (
    <JobCard
      job={job}
      restarting={restarting}
      busy={busy}
      onRollback={() => setConfirmRollback(true)}
    />
  );

  const channel = status?.channel ?? null;
  const current = channel ? status?.remotes[channel] : null;
  const switching = confirm && confirm.branch !== status?.branch;

  return (
    <Stack gap="lg">
      {header}
      {reload && (
        <Alert
          variant="light"
          color="green"
          radius="lg"
          icon={<IconCheck size={18} />}
          title="This panel is now running a different version"
        >
          <Group justify="space-between" wrap="wrap">
            <Text size="sm">Reload the page to use it.</Text>
            <Button size="xs" onClick={() => location.reload()}>
              Reload
            </Button>
          </Group>
        </Alert>
      )}
      {statusError && (
        <Alert
          variant="light"
          color="red"
          radius="lg"
          icon={<IconAlertTriangle size={18} />}
          title="The updater did not answer"
        >
          {statusError}. Check it on the host with <Code>docker compose ps updater</Code> and{' '}
          <Code>docker compose logs updater</Code>.
        </Alert>
      )}
      <ErrorText error={error} />
      {status && (
        <Grid gap="lg" align="flex-start">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Stack gap="lg">
              {job?.status === 'running' && jobCard}
              <Card padding="lg">
                <Stack gap="md">
                  <Group justify="space-between" wrap="wrap">
                    <Text fw={650}>
                      {channel ? `Available on ${channelLabel(channel)}` : 'Available updates'}
                    </Text>
                    {current && current.behind === 0 && (
                      <Badge
                        variant="light"
                        color="green"
                        leftSection={<IconCheck size={12} />}
                        tt="none"
                      >
                        Up to date
                      </Badge>
                    )}
                  </Group>
                  {!channel && (
                    <Text size="sm" c="dimmed">
                      The checkout is on{' '}
                      {status.branch ? <Code>{status.branch}</Code> : 'no branch'}, which is not a
                      channel. Switch to one on the right.
                    </Text>
                  )}
                  {channel && !current && (
                    <Text size="sm" c="red">
                      {status.fetchErrors[channel] ?? `origin/${channel} was not found.`}
                    </Text>
                  )}
                  {current && current.behind > 0 && (
                    <>
                      <Text size="sm">
                        {current.behind} new commit{current.behind === 1 ? '' : 's'}
                        {current.behind > current.commits.length
                          ? `, the newest ${current.commits.length} shown`
                          : ''}
                        .
                      </Text>
                      <ScrollArea.Autosize mah={320} type="auto">
                        <Stack gap="sm">
                          {current.commits.map((c) => (
                            <CommitLine key={c.sha} c={c} webUrl={status.webUrl} />
                          ))}
                        </Stack>
                      </ScrollArea.Autosize>
                      {current.schema > running.schema && (
                        <Alert
                          variant="light"
                          color="yellow"
                          radius="md"
                          icon={<IconDatabase size={18} />}
                        >
                          Includes a database migration (schema {running.schema} → {current.schema}
                          ). The backup taken before the restart is what a roll back restores.
                        </Alert>
                      )}
                      {current.ahead > 0 && (
                        <Text size="sm" c="red">
                          The checkout has {current.ahead} commit{current.ahead === 1 ? '' : 's'}{' '}
                          that {channel} does not, so it cannot fast-forward. Resolve it on the
                          host.
                        </Text>
                      )}
                      <Group>
                        <Button
                          leftSection={<IconCloudDownload size={16} />}
                          disabled={
                            busy || job?.status === 'running' || status.dirty || current.ahead > 0
                          }
                          onClick={() => setConfirm({ branch: channel!, ch: current })}
                        >
                          Update to {short(current.sha)}
                        </Button>
                      </Group>
                    </>
                  )}
                </Stack>
              </Card>
              {job && job.status !== 'running' && jobCard}
            </Stack>
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Stack gap="lg">
              <Card padding="lg">
                <Stack gap="sm">
                  <Group gap="sm">
                    <ThemeIcon variant="light" size={36} radius="md">
                      <IconGitBranch size={20} stroke={1.6} />
                    </ThemeIcon>
                    <Stack gap={0}>
                      <Text fw={650}>This panel</Text>
                      <Group gap={6}>
                        {status.branch && (
                          <Badge
                            variant="light"
                            color={CHANNEL[status.branch]?.color ?? 'gray'}
                            tt="none"
                          >
                            {channelLabel(status.branch)}
                          </Badge>
                        )}
                        <Text size="xs" c="dimmed">
                          schema {running.schema}
                        </Text>
                      </Group>
                    </Stack>
                  </Group>
                  <Text size="sm">
                    Running <Code>{short(running.commit)}</Code>
                    {running.commit && running.commit !== status.head.sha && (
                      <Text span size="xs" c="orange">
                        {' '}
                        (the checkout is on {short(status.head.sha)}; it was changed without a
                        rebuild)
                      </Text>
                    )}
                  </Text>
                  <CommitLine c={status.head} webUrl={status.webUrl} />
                  {status.dirty && (
                    <Text size="sm" c="red">
                      The checkout has uncommitted changes, so updates are paused. Commit or stash
                      them on the host.
                    </Text>
                  )}
                </Stack>
              </Card>

              <Card padding="lg">
                <Stack gap="sm">
                  <Text fw={650}>Channel</Text>
                  {status.channels.map((ch) => {
                    const r = status.remotes[ch];
                    const here = ch === status.branch;
                    const blocked = r && r.schema < running.schema;
                    return (
                      <Card key={ch} withBorder shadow="none" radius="md" padding="sm">
                        <Stack gap={6}>
                          <Group justify="space-between" wrap="nowrap">
                            <Group gap={6}>
                              <Badge
                                variant={here ? 'filled' : 'light'}
                                color={CHANNEL[ch]?.color ?? 'gray'}
                                tt="none"
                              >
                                {channelLabel(ch)}
                              </Badge>
                              <Text size="xs" c="dimmed">
                                {ch}
                              </Text>
                            </Group>
                            {here ? (
                              <Text size="xs" c="dimmed">
                                Current
                              </Text>
                            ) : (
                              r && (
                                <Tip
                                  label={
                                    blocked
                                      ? `${ch} expects database schema ${r.schema}, older than this panel's ${running.schema}. Older code cannot read a newer database.`
                                      : `Builds ${ch} at ${short(r.sha)} and restarts on it`
                                  }
                                >
                                  <Button
                                    size="compact-xs"
                                    variant="light"
                                    disabled={
                                      !!blocked || busy || job?.status === 'running' || status.dirty
                                    }
                                    onClick={() => setConfirm({ branch: ch, ch: r })}
                                  >
                                    Switch
                                  </Button>
                                </Tip>
                              )
                            )}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {CHANNEL[ch]?.about ?? 'A branch this panel may follow.'}
                          </Text>
                          {!r && (
                            <Text size="xs" c="dimmed">
                              Not on the remote{status.fetchErrors[ch] ? ' (fetch failed)' : ''}.
                            </Text>
                          )}
                        </Stack>
                      </Card>
                    );
                  })}
                  <Text size="xs" c="dimmed">
                    To try nightly without risking your stable panel, run it as a second instance
                    with its own directory, port and <Code>PI_PANEL_NAMESPACE</Code> (see the
                    README).
                  </Text>
                </Stack>
              </Card>
            </Stack>
          </Grid.Col>
        </Grid>
      )}

      <Modal
        opened={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          <Text fw={650}>
            {switching
              ? `Switch this panel to ${channelLabel(confirm!.branch)}?`
              : `Update to ${short(confirm?.ch.sha)}?`}
          </Text>
        }
      >
        {confirm && (
          <Stack gap="md">
            <List size="sm" spacing={4}>
              <List.Item>The new version is built while this panel keeps running.</List.Item>
              <List.Item>
                Then the panel stops for a moment: running agent sessions end, and the database and
                secret.key are backed up to <Code>data/backups</Code>.
              </List.Item>
              <List.Item>
                If the new version does not answer within three minutes, the previous one is put
                back on its own.
              </List.Item>
            </List>
            {switching && (
              <Alert
                variant="light"
                color="yellow"
                radius="md"
                icon={<IconAlertTriangle size={18} />}
              >
                After this, the panel follows {confirm.branch}.
                {confirm.ch.schema > running.schema &&
                  ` Its database migration (schema ${running.schema} → ${confirm.ch.schema}) means switching back later needs this backup.`}
              </Alert>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    const { job: started } = await applyUpdate(confirm.branch, confirm.ch.sha);
                    setJob(started);
                    setConfirm(null);
                  })
                }
              >
                {switching ? 'Switch' : 'Update'}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      <Modal
        opened={confirmRollback}
        onClose={() => setConfirmRollback(false)}
        title={<Text fw={650}>Roll back to {short(job?.from.sha)}?</Text>}
      >
        {job && (
          <Stack gap="md">
            <Text size="sm">
              The previous image and commit are put back and the panel restarts.
              {job.to.schema !== job.from.schema
                ? ' The database schema changed in this update, so the backup is restored: anything done since the update is lost.'
                : ' The database schema did not change, so your data is kept.'}
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setConfirmRollback(false)}>
                Cancel
              </Button>
              <Button
                color="orange"
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    const { job: started } = await rollbackUpdate();
                    setJob(started);
                    setConfirmRollback(false);
                  })
                }
              >
                Roll back
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
