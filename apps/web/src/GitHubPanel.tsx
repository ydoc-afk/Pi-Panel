import { useEffect, useState, type FormEvent } from 'react';
import {
  cloneRepo,
  getGitHub,
  getRepoStatus,
  openPullRequest,
  pushBranch,
  type GitHubAccount,
  type RepoStatus,
} from './api.js';

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

  if (!status || !account) return error ? <p role="alert">{error}</p> : <p>Loading GitHub...</p>;

  return (
    <details style={{ margin: '12px 0' }} open>
      <summary>GitHub{status.repo ? `: ${status.repo}` : ''}</summary>
      {!account.connected && (
        <p>
          Connect GitHub in the GitHub tab to push and open pull requests. Public repositories can
          still be cloned.
        </p>
      )}
      {!status.repo ? (
        <form onSubmit={clone} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            placeholder="owner/name or https://github.com/owner/name"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            style={{ minWidth: 280 }}
          />
          <input
            placeholder="Branch (optional)"
            value={cloneBranch}
            onChange={(e) => setCloneBranch(e.target.value)}
          />
          <button disabled={busy || !repo.trim()}>Clone into workspace</button>
        </form>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            On <strong>{status.branch ?? 'no branch'}</strong> &middot; {status.changes} uncommitted
            change{status.changes === 1 ? '' : 's'}
          </div>
          {account.connected && (
            <form onSubmit={push} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                placeholder="Branch to push, e.g. pi/my-change"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
              <input
                placeholder="Commit message (optional)"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                style={{ minWidth: 240 }}
              />
              <button disabled={busy || !branch.trim()}>Commit &amp; push</button>
            </form>
          )}
          {pushedBranch && account.connected && (
            <form onSubmit={openPr} style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
              <strong>Open a pull request from {pushedBranch}</strong>
              <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea
                placeholder="Description (optional)"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <button disabled={busy || !title.trim()}>Open pull request</button>
              {prUrl && (
                <a href={prUrl} target="_blank" rel="noopener noreferrer">
                  {prUrl}
                </a>
              )}
            </form>
          )}
        </div>
      )}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </details>
  );
}
