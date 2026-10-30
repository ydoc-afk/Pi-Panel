import { useEffect, useState, type FormEvent } from 'react';
import {
  Anchor,
  Button,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  cloneRepo,
  getGitHub,
  getRepoStatus,
  openPullRequest,
  pushBranch,
  type GitHubAccount,
  type RepoStatus,
} from './api.js';
import { Collapsible, ErrorText } from './ui.js';

export function GitHubPanel({ projectId }: { projectId: number }) {
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [cloneBranch, setCloneBranch] = useState('');
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [pushedBranch, setPushedBranch] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([getGitHub(), getRepoStatus(projectId)])
      .then(([a, s]) => {
        setAccount(a);
        setStatus(s);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, [projectId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const clone = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await cloneRepo(projectId, repo, cloneBranch.trim() || undefined);
    });
  };

  const push = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result = await pushBranch(projectId, branch.trim(), message.trim() || undefined);
      setPushedBranch(result.branch);
      setPrUrl('');
    });
  };

  const openPr = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const pr = await openPullRequest(projectId, {
        head: pushedBranch,
        title: title.trim(),
        body: body.trim() || undefined,
      });
      setPrUrl(pr.url);
    });
  };

  if (!status || !account) {
    return error ? <ErrorText error={error} /> : <Loader size="sm" />;
  }

  return (
    <Collapsible title={`GitHub${status.repo ? `: ${status.repo}` : ''}`}>
      <Stack gap="sm">
        {!account.connected && (
          <Text size="sm" c="dimmed">
            Connect GitHub in the GitHub tab to push and open pull requests. Public repositories can
            still be cloned.
          </Text>
        )}
        {!status.repo ? (
          <form onSubmit={clone}>
            <Group gap="xs" align="flex-end">
              <TextInput
                placeholder="owner/name or https://github.com/owner/name"
                value={repo}
                onChange={(e) => setRepo(e.currentTarget.value)}
                w={320}
              />
              <TextInput
                placeholder="Branch (optional)"
                value={cloneBranch}
                onChange={(e) => setCloneBranch(e.currentTarget.value)}
              />
              <Button type="submit" disabled={busy || !repo.trim()}>
                Clone into workspace
              </Button>
            </Group>
          </form>
        ) : (
          <>
            <Text size="sm">
              On <Code>{status.branch ?? 'no branch'}</Code> · {status.changes} uncommitted change
              {status.changes === 1 ? '' : 's'}
            </Text>
            {account.connected && (
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
                  <Button type="submit" disabled={busy || !branch.trim()}>
                    Commit &amp; push
                  </Button>
                </Group>
              </form>
            )}
            {pushedBranch && account.connected && (
              <form onSubmit={openPr}>
                <Stack gap="xs" maw={520}>
                  <Text fw={600}>Open a pull request from {pushedBranch}</Text>
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
                    <Button type="submit" disabled={busy || !title.trim()}>
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
          </>
        )}
        <ErrorText error={error} />
      </Stack>
    </Collapsible>
  );
}
