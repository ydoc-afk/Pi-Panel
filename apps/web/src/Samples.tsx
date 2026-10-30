import { useEffect, useRef, useState } from 'react';
import { deleteSample, listSamples, uploadSample, type SampleFile } from './api.js';

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} kB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Files for analysis. Managed servers see them under /samples; the agent's own container does not. */
export function Samples({ projectId }: { projectId: number }) {
  const [files, setFiles] = useState<SampleFile[]>([]);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listSamples(projectId)
      .then(setFiles)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, [projectId]);

  async function upload(list: FileList | null) {
    if (!list) return;
    setError('');
    for (const file of Array.from(list)) {
      setUploading(file.name);
      try {
        await uploadSample(projectId, file);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`);
        break;
      }
    }
    setUploading('');
    if (input.current) input.current.value = '';
    await refresh();
  }

  return (
    <details style={{ margin: '8px 0' }} open>
      <summary>Samples ({files.length})</summary>
      <p style={{ margin: '6px 0', fontSize: 13 }}>
        Files for analysis tools. They are mounted read-only inside managed containers at{' '}
        <code>/samples/&lt;name&gt;</code> and are not visible to the agent&apos;s own container.
        Start a new session after changing the list so the agent learns the names.
      </p>
      <input
        ref={input}
        type="file"
        multiple
        disabled={!!uploading}
        onChange={(e) => void upload(e.target.files)}
      />
      {uploading && <span> Uploading {uploading}&hellip;</span>}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      <ul style={{ paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
        {files.map((f) => (
          <li key={f.name}>
            <code>{f.name}</code> <small>{size(f.size)}</small>{' '}
            <button
              onClick={() => {
                if (confirm(`Delete ${f.name}?`)) {
                  void deleteSample(projectId, f.name)
                    .then(refresh)
                    .catch((e: Error) => setError(e.message));
                }
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
