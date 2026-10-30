import { useEffect, useState, type FormEvent } from 'react';
import {
  installPackage,
  listPackages,
  previewPackage,
  removePackage,
  type InstalledPackage,
  type PackageChange,
  type PackageReview,
} from './api.js';

const kb = (n: number | null) =>
  n === null ? 'unknown' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;

function Review({
  review,
  busy,
  onInstall,
  onCancel,
}: {
  review: PackageReview;
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const r = review;
  const res = r.resources;
  return (
    <div
      style={{
        border: '1px solid #8886',
        borderRadius: 6,
        padding: 12,
        margin: '8px 0',
        maxWidth: 560,
      }}
    >
      <strong>
        {r.name}@{r.version}
      </strong>
      {r.description && <div>{r.description}</div>}
      {r.warnings.length > 0 && (
        <ul style={{ color: 'darkorange' }}>
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '2px 12px',
          margin: '8px 0',
        }}
      >
        <dt>License</dt>
        <dd>{r.license ?? 'none listed'}</dd>
        <dt>Publisher</dt>
        <dd>{r.publisher ?? 'unknown'}</dd>
        <dt>Repository</dt>
        <dd>{r.repository ?? 'none listed'}</dd>
        <dt>Contents</dt>
        <dd>
          {res
            ? `${res.extensions} extension(s), ${res.skills} skill(s), ${res.prompts} prompt(s), ${res.themes} theme(s)`
            : 'no pi manifest'}
          {' · '}
          {r.fileCount ?? '?'} files, {kb(r.unpackedBytes)}
        </dd>
        <dt>Dependencies</dt>
        <dd>{r.dependencies.length === 0 ? 'none' : r.dependencies.join(', ')}</dd>
      </dl>
      <div>
        Inspect the code first:{' '}
        <a href={r.links.files} target="_blank" rel="noopener noreferrer">
          browse files
        </a>{' '}
        &middot;{' '}
        <a href={r.links.npm} target="_blank" rel="noopener noreferrer">
          npm page
        </a>
      </div>
      <p style={{ marginBottom: 8 }}>
        Packages run with the agent&apos;s permissions inside this project&apos;s container. Install
        scripts are disabled. This exact version will be installed.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={onInstall}>
          Install {r.name}@{r.version}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Packages({ projectId }: { projectId: number }) {
  const [packages, setPackages] = useState<InstalledPackage[] | null>(null);
  const [source, setSource] = useState('');
  const [review, setReview] = useState<PackageReview | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listPackages(projectId)
      .then(setPackages)
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  async function run(action: () => Promise<void>) {
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

  const applied = (verb: string, change: PackageChange) => {
    setPackages(change.packages);
    const parts = [`${verb}.`];
    if (change.restartedSessions > 0)
      parts.push(`${change.restartedSessions} idle session(s) will reload on their next prompt.`);
    if (change.pendingSessions > 0)
      parts.push(
        `${change.pendingSessions} running session(s) pick it up after they finish and restart.`,
      );
    setNotice(parts.join(' '));
  };

  const doReview = (e: FormEvent) => {
    e.preventDefault();
    setNotice('');
    void run(async () => {
      const value = source.trim();
      setReview(await previewPackage(projectId, value.startsWith('npm:') ? value : `npm:${value}`));
    });
  };

  return (
    <details style={{ margin: '12px 0' }} open>
      <summary>Pi packages{packages ? ` (${packages.length})` : ''}</summary>
      {packages && packages.length > 0 && (
        <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {packages.map((p) => (
            <li key={p.source} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code>{p.source}</code>
              {p.filtered && <small>(resources filtered)</small>}
              <button
                disabled={busy}
                onClick={() => {
                  if (confirm(`Remove ${p.source}?`)) {
                    void run(async () =>
                      applied('Removed', await removePackage(projectId, p.source)),
                    );
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={doReview} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          placeholder="npm package, e.g. @scope/name or npm:name@1.2.3"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setReview(null);
          }}
          style={{ minWidth: 300 }}
        />
        <button disabled={busy || !source.trim()}>Review</button>
      </form>
      {review && (
        <Review
          review={review}
          busy={busy}
          onCancel={() => setReview(null)}
          onInstall={() =>
            void run(async () => {
              applied('Installed', await installPackage(projectId, review.source));
              setReview(null);
              setSource('');
            })
          }
        />
      )}
      {notice && <p>{notice}</p>}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
    </details>
  );
}
