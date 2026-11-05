import { useEffect, useState, type FormEvent } from 'react';
import {
  Anchor,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  addRepo,
  listRepos,
  openRepoPullRequest,
  pullAllRepos,
  pullRepo,
  pushAllRepos,
  pushRepo,
  removeRepo,
  setRepoIncluded,
  type BulkRepoResult,
  type Forge,
  type ProjectRepo,
  type RepoList,
} from './api.js';
import { askConfirm } from './ConfirmDialog.js';
import { ErrorText, FlatSection } from './ui.js';

const FORGE_NAME: Record<Forge, string> = { github: 'GitHub', forgejo: 'Forgejo' };

/** One line per repository: what a pull all / push all did to it. */
function BulkSummary({ title, results }: { title: string; results: BulkRepoResult[] }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap={2}>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        {results.length === 0 && (
          <Text size="sm" c="dimmed">
            No repository is included. Tick one first.
          </Text>
        )}
        {results.map((r) => (
          <Text key={r.id} size="sm" c={r.ok ? undefined : 'red'}>
            <Code>{r.repo}</Code>{' '}
            {r.ok
              ? r.updated === false
                ? 'already up to date'
                : r.updated
                  ? 'updated'
                  : r.committed
                    ? `committed and pushed ${r.branch ?? ''}`
                    : `pushed ${r.branch ?? ''}`
              : r.error}
          </Text>
        ))}
      </Stack>
    </Paper>
  );
}

function RepoCard({
  projectId,
  repo,
  canPush,
  onChanged,
}: {
  projectId: number;
  repo: ProjectRepo;
  /** The forge account is connected, which pushing and pull requests need. */
  canPush: boolean;
  onChanged: () => Promise<void>;
}) {
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [pushedBranch, setPushedBranch] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const push = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await pushRepo(projectId, repo.id, branch.trim(), message.trim() || undefined);
      setPushedBranch(r.branch);
      setPrUrl('');
      setNote(`Pushed ${r.branch}${r.committed ? ' (changes were committed first)' : ''}.`);
    });
  };

  const openPr = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const pr = await openRepoPullRequest(projectId, repo.id, {
        head: pushedBranch,
        title: title.trim(),
        body: body.trim() || undefined,
      });
      setPrUrl(pr.url);
    });
  };

  return (
    <Paper withBorder radius="lg" p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Checkbox
            checked={repo.included}
            disabled={busy}
            onChange={(e) => {
              const included = e.currentTarget.checked;
              void run(async () => {
                await setRepoIncluded(projectId, repo.id, included);
              });
            }}
            label={
              <Group gap="xs">
                <Text fw={600}>{repo.repo}</Text>
                <Badge variant="light" color={repo.host === 'forgejo' ? 'orange' : 'gray'}>
                  {FORGE_NAME[repo.host]}
                </Badge>
              </Group>
            }
            description={
              repo.included
                ? 'Included: pull all, push all and the agent can use it'
                : 'Not included: left out of pull all, push all and the agent’s push tools'
            }
          />
          <Group gap="xs" wrap="nowrap">
            <Button
              size="xs"
              variant="default"
              loading={busy}
              disabled={!canPush}
              onClick={() =>
                void run(async () => {
                  const r = await pullRepo(projectId, repo.id);
                  setNote(r.updated ? `Updated ${r.branch}.` : `${r.branch} is up to date.`);
                })
              }
            >
              Pull
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (
                    !(await askConfirm(
                      `Remove ${repo.repo} from this project? Its files stay in the workspace at ${repo.path}.`,
                    ))
                  )
                    return;
                  await run(async () => {
                    await removeRepo(projectId, repo.id);
                  });
                })()
              }
            >
              Remove
            </Button>
          </Group>
        </Group>

        <Text size="sm">
          <Code>{repo.path}</Code>
          {repo.error ? (
            <Text span c="red">
              {' '}
              · {repo.error}
            </Text>
          ) : (
            <>
              {' '}
              · on <Code>{repo.branch ?? 'no branch'}</Code> · {repo.changes} uncommitted change
              {repo.changes === 1 ? '' : 's'}
              {repo.ahead === null
                ? ''
                : ` · ${repo.ahead} commit${repo.ahead === 1 ? '' : 's'} to push`}
            </>
          )}
        </Text>

        {canPush && !repo.error && (
          <form onSubmit={push}>
            <Group gap="xs" align="flex-end">
              <TextInput
                placeholder="Branch to push, e.g. pi/my-change"
                value={branch}
                onChange={(e) => setBranch(e.currentTarget.value)}
              />
              <TextInput
                placeholder="Commit message (optional)"
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                w={260}
              />
              <Button type="submit" size="sm" disabled={busy || !branch.trim()}>
                Commit &amp; push
              </Button>
            </Group>
          </form>
        )}
        {pushedBranch && canPush && (
          <form onSubmit={openPr}>
            <Stack gap="xs" maw={520}>
              <Text fw={600} size="sm">
                Open a pull request from {pushedBranch}
              </Text>
              <TextInput
                placeholder="Title"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <Textarea
                placeholder="Description (optional)"
                value={body}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
              <Group gap="xs">
                <Button type="submit" size="sm" disabled={busy || !title.trim()}>
                  Open pull request
                </Button>
              </Group>
              {prUrl && (
                <Anchor href={prUrl} target="_blank" rel="noopener noreferrer" size="sm">
                  {prUrl}
                </Anchor>
              )}
            </Stack>
          </form>
        )}
        {note && (
          <Text size="sm" c="dimmed">
            {note}
          </Text>
        )}
        <ErrorText error={error} />
      </Stack>
    </Paper>
  );
}

/**
 * All of a project's repositories, GitHub and Forgejo together. Each is cloned into its own folder
 * of the workspace. The checkbox says whether it takes part in pull all, push all and the agent's
 * push and pull request tools.
 */
export function RepositoryPanel({ projectId }: { projectId: number }) {
  const [data, setData] = useState<RepoList | null>(null);
  const [host, setHost] = useState<Forge>('github');
  const [repo, setRepo] = useState('');
  const [cloneBranch, setCloneBranch] = useState('');
  const [message, setMessage] = useState('');
  const [bulk, setBulk] = useState<{ title: string; results: BulkRepoResult[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'add' | 'pull' | 'push'>('');

  const refresh = () =>
    listRepos(projectId)
      .then(setData)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    setData(null);
    void refresh();
  }, [projectId]);

  async function run(kind: 'add' | 'pull' | 'push', action: () => Promise<void>) {
    setBusy(kind);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run('add', async () => {
      await addRepo(projectId, host, repo.trim(), cloneBranch.trim() || undefined);
      setRepo('');
      setCloneBranch('');
    });
  };

  if (!data) return error ? <ErrorText error={error} /> : <Loader size="sm" />;

  const included = data.repos.filter((r) => r.included);
  const missingAccount = (['github', 'forgejo'] as Forge[]).filter((f) => !data.accounts[f]);

  return (
    <FlatSection>
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Text fw={650} size="lg">
            Repositories
          </Text>
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              loading={busy === 'pull'}
              disabled={included.length === 0 || busy !== ''}
              onClick={() =>
                void run('pull', async () => {
                  setBulk({ title: 'Pull all', results: await pullAllRepos(projectId) });
                })
              }
            >
              Pull all ({included.length})
            </Button>
            <Button
              size="xs"
              loading={busy === 'push'}
              disabled={included.length === 0 || busy !== ''}
              onClick={() =>
                void (async () => {
                  if (
                    !(await askConfirm(
                      `Commit and push the current branch of ${included.length} included repositor${included.length === 1 ? 'y' : 'ies'}?`,
                    ))
                  )
                    return;
                  await run('push', async () => {
                    setBulk({
                      title: 'Push all',
                      results: await pushAllRepos(projectId, message.trim() || undefined),
                    });
                  });
                })()
              }
            >
              Push all ({included.length})
            </Button>
          </Group>
        </Group>
        <Text size="sm" c="dimmed">
          Tick the repositories that take part in pull all, push all and the agent’s push and pull
          request tools. Unticked ones stay in the workspace but are left alone. Push all uses each
          repository’s current branch.
        </Text>
        {included.length > 0 && (
          <TextInput
            size="xs"
            placeholder="Commit message for push all (optional)"
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            maw={420}
          />
        )}
        {missingAccount.length > 0 && (
          <Text size="sm" c="dimmed">
            {missingAccount.map((f) => FORGE_NAME[f]).join(' and ')} not connected: add a token in
            the {missingAccount.map((f) => FORGE_NAME[f]).join(' / ')} page of the main menu to push
            and open pull requests. Public GitHub repositories can still be cloned.
          </Text>
        )}
        <ErrorText error={error} />
        {bulk && <BulkSummary title={bulk.title} results={bulk.results} />}

        {data.repos.length === 0 && (
          <Text size="sm" c="dimmed">
            No repositories yet. Add one below; it is cloned into its own folder of the workspace.
          </Text>
        )}
        {data.repos.map((r) => (
          <RepoCard
            key={r.id}
            projectId={projectId}
            repo={r}
            canPush={data.accounts[r.host]}
            onChanged={refresh}
          />
        ))}

        <Paper withBorder radius="lg" p="md">
          <form onSubmit={add}>
            <Stack gap="xs">
              <Text fw={600}>Add a repository</Text>
              <SegmentedControl
                size="xs"
                w={220}
                value={host}
                onChange={(v) => setHost(v as Forge)}
                data={[
                  { label: 'GitHub', value: 'github' },
                  { label: 'Forgejo', value: 'forgejo' },
                ]}
              />
              <Group gap="xs" align="flex-end">
                <TextInput
                  placeholder={
                    host === 'forgejo'
                      ? 'owner/name or the full repository URL'
                      : 'owner/name or https://github.com/owner/name'
                  }
                  value={repo}
                  onChange={(e) => setRepo(e.currentTarget.value)}
                  w={340}
                />
                <TextInput
                  placeholder="Branch (optional)"
                  value={cloneBranch}
                  onChange={(e) => setCloneBranch(e.currentTarget.value)}
                />
                <Button
                  type="submit"
                  loading={busy === 'add'}
                  disabled={busy !== '' || !repo.trim()}
                >
                  Clone into workspace
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      </Stack>
    </FlatSection>
  );
}
