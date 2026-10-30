import { useEffect, useState, type FormEvent } from 'react';
import {
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  listLabPackages,
  runLab,
  scaffoldLabPackage,
  type LabDiagnostic,
  type LabKind,
  type LabPackage,
  type LabRun,
  type LabTest,
} from './api.js';
import { Collapsible, ErrorText, mono } from './ui.js';

const KINDS: LabKind[] = ['extension', 'skill', 'prompt', 'theme'];

interface TestRow {
  tool: string;
  input: string;
  expectContains: string;
  expectError: boolean;
}

const emptyRow = (): TestRow => ({ tool: '', input: '{}', expectContains: '', expectError: false });
const rowFrom = (t: LabTest): TestRow => ({
  tool: t.tool,
  input: JSON.stringify(t.input),
  expectContains: t.expectContains ?? '',
  expectError: t.expectError ?? false,
});

/** Turns editor rows into API tests, or returns the first problem. */
function toTests(rows: TestRow[]): { tests: LabTest[] } | { error: string } {
  const tests: LabTest[] = [];
  for (const [i, r] of rows.entries()) {
    if (!r.tool.trim()) continue;
    let input: unknown;
    try {
      input = JSON.parse(r.input || '{}');
    } catch {
      return { error: `Test ${i + 1}: input is not valid JSON` };
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { error: `Test ${i + 1}: input must be a JSON object` };
    }
    tests.push({
      tool: r.tool.trim(),
      input: input as Record<string, unknown>,
      ...(r.expectContains ? { expectContains: r.expectContains } : {}),
      ...(r.expectError ? { expectError: true } : {}),
    });
  }
  return { tests };
}

function Diagnostics({ items }: { items: LabDiagnostic[] }) {
  if (items.length === 0) return null;
  return (
    <Stack gap={2}>
      {items.map((d, i) => (
        <Text key={i} size="sm" c={d.type === 'error' ? 'red' : 'orange'}>
          <Text span fw={600} inherit>
            {d.kind}
          </Text>{' '}
          {d.path}: {d.message}
        </Text>
      ))}
    </Stack>
  );
}

function Results({ result }: { result: LabRun }) {
  const r = result.report;
  const failed = result.status !== 'completed' || !r?.ok;
  const verdict =
    result.status === 'timeout'
      ? 'Timed out'
      : result.status === 'no-report'
        ? 'No report produced'
        : r?.ok
          ? 'Passed'
          : 'Failed';
  return (
    <Paper withBorder p="md" radius="md" mt="sm">
      <Stack gap="sm">
        <Group gap="xs">
          <Badge color={failed ? 'red' : 'green'} variant="filled">
            {verdict}
          </Badge>
          <Text size="xs" c="dimmed">
            {result.run.files} files copied, {(result.run.durationMs / 1000).toFixed(1)} s
            {r?.sdkVersion ? `, pi ${r.sdkVersion}` : ''}
          </Text>
        </Group>

        {result.run.skipped.length > 0 && (
          <Collapsible
            defaultOpen={false}
            title={`${result.run.skipped.length} item(s) not copied`}
          >
            <Stack gap={2}>
              {result.run.skipped.map((s) => (
                <Text key={s} size="sm">
                  {s}
                </Text>
              ))}
            </Stack>
          </Collapsible>
        )}

        {r && (
          <>
            {r.harnessError && (
              <Code block c="red" style={{ whiteSpace: 'pre-wrap' }}>
                {r.harnessError}
              </Code>
            )}
            {r.sessionError && (
              <Text size="sm" c="red">
                Session error: {r.sessionError}
              </Text>
            )}
            {(r.extensionErrors ?? []).map((e) => (
              <Text key={e.path} size="sm" c="red" style={{ whiteSpace: 'pre-wrap' }}>
                <Text span fw={600} inherit>
                  {e.path}
                </Text>{' '}
                failed to load: {e.error}
              </Text>
            ))}
            <Diagnostics items={r.diagnostics ?? []} />

            <Table verticalSpacing="xs" withRowBorders={false}>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td c="dimmed" w={120}>
                    Extensions
                  </Table.Td>
                  <Table.Td>{(r.extensions ?? []).join(', ') || 'none'}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td c="dimmed">Tools</Table.Td>
                  <Table.Td>
                    {(r.tools ?? []).length === 0 ? (
                      'none'
                    ) : (
                      <Stack gap={4}>
                        {(r.tools ?? []).map((t) => (
                          <Collapsible
                            key={t.name}
                            defaultOpen={false}
                            title={
                              <>
                                <Code>{t.name}</Code>{' '}
                                <Text span size="sm" c="dimmed">
                                  {t.description}
                                </Text>
                              </>
                            }
                          >
                            <Code block style={mono}>
                              {JSON.stringify(t.parameters, null, 2)}
                            </Code>
                          </Collapsible>
                        ))}
                      </Stack>
                    )}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td c="dimmed">Commands</Table.Td>
                  <Table.Td>
                    {(r.commands ?? []).map((c) => `/${c.name}`).join(', ') || 'none'}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td c="dimmed">Skills</Table.Td>
                  <Table.Td>{(r.skills ?? []).map((s) => s.name).join(', ') || 'none'}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td c="dimmed">Prompts</Table.Td>
                  <Table.Td>
                    {(r.prompts ?? []).map((p) => `/${p.name}`).join(', ') || 'none'}
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td c="dimmed">Themes</Table.Td>
                  <Table.Td>{(r.themes ?? []).map((t) => t.name).join(', ') || 'none'}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>

            {(r.tests ?? []).length > 0 && (
              <Table striped highlightOnHover verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Test</Table.Th>
                    <Table.Th>Result</Table.Th>
                    <Table.Th>Detail</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {(r.tests ?? []).map((t, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>
                        <Text span c={t.ok ? 'green' : 'red'} fw={700}>
                          {t.ok ? '✓' : '✗'}
                        </Text>{' '}
                        <Code>{t.tool}</Code>
                      </Table.Td>
                      <Table.Td>{t.status}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'pre-wrap', ...mono }}>
                        {t.schemaErrors.length > 0
                          ? t.schemaErrors.join('\n')
                          : (t.error ?? t.output)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </>
        )}

        {result.run.stderr && (
          <Collapsible defaultOpen={false} title="stderr">
            <Code block style={{ ...mono, whiteSpace: 'pre-wrap' }}>
              {result.run.stderr}
            </Code>
          </Collapsible>
        )}
      </Stack>
    </Paper>
  );
}

export function Lab({ projectId }: { projectId: number }) {
  const [packages, setPackages] = useState<LabPackage[]>([]);
  const [selected, setSelected] = useState('');
  const [rows, setRows] = useState<TestRow[]>([]);
  const [name, setName] = useState('');
  const [kinds, setKinds] = useState<string[]>(['extension']);
  const [result, setResult] = useState<LabRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const refresh = async (select?: string) => {
    const list = await listLabPackages(projectId);
    setPackages(list);
    setSelected(
      (cur) => select ?? (list.some((p) => p.path === cur) ? cur : (list[0]?.path ?? '')),
    );
  };

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [projectId]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const created = await scaffoldLabPackage(projectId, name.trim(), kinds as LabKind[]);
      setName('');
      setResult(null);
      setRows(created.sampleTests.map(rowFrom));
      await refresh(created.package.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  }

  async function run() {
    const parsed = toTests(rows);
    if ('error' in parsed) return setError(parsed.error);
    setError('');
    setRunning(true);
    setResult(null);
    try {
      setResult(await runLab(projectId, selected, parsed.tests));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setRunning(false);
    }
  }

  const update = (i: number, patch: Partial<TestRow>) =>
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toolNames = (result?.report?.tools ?? []).map((t) => t.name);

  return (
    <Collapsible title="Package lab">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Build and test extensions, skills, prompts and themes. Runs use a throwaway container with
          no network and no credentials. Results are advisory: the package&apos;s own code runs
          there and could influence the report.
        </Text>

        <form onSubmit={create}>
          <Group gap="xs" align="flex-end">
            <TextInput
              placeholder="new-package-name"
              aria-label="New package name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Checkbox.Group value={kinds} onChange={setKinds}>
              <Group gap="xs">
                {KINDS.map((k) => (
                  <Checkbox key={k} value={k} label={k} />
                ))}
              </Group>
            </Checkbox.Group>
            <Button type="submit" disabled={!name.trim() || kinds.length === 0}>
              Create starter package
            </Button>
          </Group>
        </form>

        <Group gap="xs" align="flex-end">
          <Select
            aria-label="Package"
            placeholder={packages.length === 0 ? 'No packages found' : 'Choose a package'}
            w={380}
            value={selected || null}
            data={packages.map((p) => ({
              value: p.path,
              label: `${p.path}${p.name ? ` (${p.name})` : ''}`,
            }))}
            onChange={(v) => setSelected(v ?? '')}
          />
          <Button
            variant="default"
            onClick={() => void refresh().catch((e: Error) => setError(e.message))}
          >
            Rescan
          </Button>
        </Group>

        {selected && (
          <Stack gap="xs">
            {rows.map((r, i) => (
              <Group key={i} gap="xs" align="flex-start" wrap="wrap">
                <Autocomplete
                  placeholder="tool name"
                  aria-label={`Test ${i + 1} tool`}
                  data={toolNames}
                  value={r.tool}
                  onChange={(v) => update(i, { tool: v })}
                  w={180}
                />
                <Textarea
                  rows={2}
                  aria-label={`Test ${i + 1} input`}
                  value={r.input}
                  onChange={(e) => update(i, { input: e.currentTarget.value })}
                  styles={{ input: mono }}
                  w={300}
                />
                <TextInput
                  placeholder="output contains (optional)"
                  aria-label={`Test ${i + 1} expected output`}
                  value={r.expectContains}
                  onChange={(e) => update(i, { expectContains: e.currentTarget.value })}
                  w={220}
                />
                <Checkbox
                  mt={8}
                  label="expect error"
                  checked={r.expectError}
                  onChange={(e) => update(i, { expectError: e.currentTarget.checked })}
                />
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  mt={4}
                  onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </Group>
            ))}
            <Group gap="xs">
              <Button variant="light" onClick={() => setRows((cur) => [...cur, emptyRow()])}>
                Add tool test
              </Button>
              <Button loading={running} onClick={() => void run()}>
                {running ? 'Running in a throwaway container...' : 'Run in lab'}
              </Button>
            </Group>
          </Stack>
        )}

        <ErrorText error={error} />
        {result && <Results result={result} />}
      </Stack>
    </Collapsible>
  );
}
