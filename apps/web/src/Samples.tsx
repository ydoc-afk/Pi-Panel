import { useEffect, useState } from 'react';
import { Button, Code, FileInput, Group, Stack, Text } from '@mantine/core';
import { deleteSample, listSamples, uploadSample, type SampleFile } from './api.js';
import { Collapsible, ErrorText } from './ui.js';

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
  // Changing the key clears the file picker once the picked files have been uploaded.
  const [pickerKey, setPickerKey] = useState(0);

  const refresh = () =>
    listSamples(projectId)
      .then(setFiles)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void refresh();
  }, [projectId]);

  async function upload(picked: File[]) {
    if (picked.length === 0) return;
    setError('');
    for (const file of picked) {
      setUploading(file.name);
      try {
        await uploadSample(projectId, file);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`);
        break;
      }
    }
    setUploading('');
    setPickerKey((k) => k + 1);
    await refresh();
  }

  return (
    <Collapsible title={`Samples (${files.length})`}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Files for analysis tools. They are mounted read-only inside managed containers at{' '}
          <Code>/samples/&lt;name&gt;</Code> and are not visible to the agent&apos;s own container.
          Start a new session after changing the list so the agent learns the names.
        </Text>
        <FileInput
          key={pickerKey}
          multiple
          disabled={!!uploading}
          placeholder="Choose files to upload"
          onChange={(v) => void upload(Array.isArray(v) ? v : v ? [v] : [])}
        />
        {uploading && <Text size="sm">Uploading {uploading}&hellip;</Text>}
        <ErrorText error={error} />
        {files.map((f) => (
          <Group key={f.name} gap="xs">
            <Code>{f.name}</Code>
            <Text size="xs" c="dimmed">
              {size(f.size)}
            </Text>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              onClick={() => {
                if (confirm(`Delete ${f.name}?`)) {
                  void deleteSample(projectId, f.name)
                    .then(refresh)
                    .catch((e: Error) => setError(e.message));
                }
              }}
            >
              Delete
            </Button>
          </Group>
        ))}
      </Stack>
    </Collapsible>
  );
}
