import { useState, type FormEvent } from 'react';
import {
  Button,
  Checkbox,
  Fieldset,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  TextInput,
  Text,
  Textarea,
} from '@mantine/core';
import {
  createMcpServer,
  updateMcpServer,
  type McpEntry,
  type McpEntryInput,
  type McpExposure,
  type McpServer,
  type McpServerInput,
} from './api.js';
import { ErrorText, mono } from './ui.js';

interface Row {
  key: string;
  value: string;
  secret: boolean;
  /** A stored secret that stays unchanged while its value box is left empty. */
  stored: boolean;
}

type Kind = 'stdio' | 'http' | 'managed';

const rowsFrom = (entries: McpEntry[] | undefined): Row[] =>
  (entries ?? []).map((e) => ({
    key: e.key,
    value: e.value ?? '',
    secret: e.secret,
    stored: e.secret && e.hasValue,
  }));

const rowsFromInput = (entries: McpEntryInput[] | undefined): Row[] =>
  (entries ?? []).map((e) => ({
    key: e.key,
    value: e.value ?? '',
    secret: e.secret,
    stored: false,
  }));

const toInputs = (rows: Row[]): McpEntryInput[] =>
  rows
    .filter((r) => r.key.trim())
    .map((r) => ({
      key: r.key.trim(),
      secret: r.secret,
      // Leaving a stored secret blank keeps it; anything else sends the typed value.
      ...(r.secret && r.stored && r.value === '' ? {} : { value: r.value }),
    }));

function Rows({
  label,
  rows,
  onChange,
  keyPlaceholder,
}: {
  label: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  keyPlaceholder: string;
}) {
  const update = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Fieldset legend={label} radius="md">
      <Stack gap="xs">
        {rows.map((r, i) => (
          <Group key={i} gap="xs" align="flex-end" wrap="wrap">
            <TextInput
              placeholder={keyPlaceholder}
              aria-label={`${label} name ${i + 1}`}
              value={r.key}
              onChange={(e) => update(i, { key: e.currentTarget.value })}
            />
            {r.secret ? (
              <PasswordInput
                autoComplete="off"
                placeholder={r.stored ? '(stored: leave blank to keep)' : 'value'}
                aria-label={`${label} value ${i + 1}`}
                value={r.value}
                onChange={(e) => update(i, { value: e.currentTarget.value })}
              />
            ) : (
              <TextInput
                placeholder={r.stored ? '(stored: leave blank to keep)' : 'value'}
                aria-label={`${label} value ${i + 1}`}
                value={r.value}
                onChange={(e) => update(i, { value: e.currentTarget.value })}
              />
            )}
            <Checkbox
              label="secret"
              checked={r.secret}
              onChange={(e) => update(i, { secret: e.currentTarget.checked, stored: false })}
            />
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </Group>
        ))}
        <Group>
          <Button
            variant="default"
            size="xs"
            onClick={() =>
              onChange([...rows, { key: '', value: '', secret: false, stored: false }])
            }
          >
            Add
          </Button>
        </Group>
      </Stack>
    </Fieldset>
  );
}

const EXPOSURE_DEFAULT = 'default';

export function McpServerForm({
  initial,
  preset,
  onSaved,
  onCancel,
}: {
  initial?: McpServer;
  preset?: McpServerInput & { name: string };
  onSaved: () => void;
  onCancel: () => void;
}) {
  const base = initial ?? preset;
  const [name, setName] = useState(base?.name ?? '');
  const [type, setType] = useState<Kind>(initial?.type ?? preset?.type ?? 'stdio');
  const [description, setDescription] = useState(base?.description ?? '');
  const [command, setCommand] = useState(base?.command ?? '');
  const [args, setArgs] = useState((base?.args ?? []).join('\n'));
  const [cwd, setCwd] = useState(base?.cwd ?? '');
  const [url, setUrl] = useState(base?.url ?? '');
  const [image, setImage] = useState(base?.image ?? '');
  const [port, setPort] = useState(base?.port ? String(base.port) : '8765');
  const [readyLog, setReadyLog] = useState(base?.readyLog ?? '');
  const [mountSamples, setMountSamples] = useState(base?.mountSamples ?? false);
  const [memoryMb, setMemoryMb] = useState(base?.memoryMb ? String(base.memoryMb) : '4096');
  const [exposure, setExposure] = useState<McpExposure | ''>(base?.exposure ?? '');
  const [timeout, setTimeoutSecs] = useState(base?.timeout ? String(base.timeout) : '');
  const [env, setEnv] = useState<Row[]>(
    initial ? rowsFrom(initial.env) : rowsFromInput(preset?.env),
  );
  const [headers, setHeaders] = useState<Row[]>(
    initial ? rowsFrom(initial.headers) : rowsFromInput(preset?.headers),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const lines = args.split('\n').filter((a) => a !== '');
    const input: McpServerInput = {
      description,
      exposure: exposure || null,
      timeout: timeout ? Number(timeout) : null,
      ...(type === 'managed'
        ? {
            image,
            command,
            args: lines,
            port: Number(port),
            readyLog,
            mountSamples,
            memoryMb: Number(memoryMb),
            env: toInputs(env),
          }
        : type === 'stdio'
          ? { command, args: lines, cwd, env: toInputs(env) }
          : { url, headers: toInputs(headers) }),
    };
    try {
      if (initial) await updateMcpServer(initial.id, input);
      else await createMcpServer({ ...input, name: name.trim(), type });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Stack gap="sm" maw={560} my="xs">
        <Group gap="xs" grow wrap="nowrap">
          <TextInput
            placeholder="Name (letters, digits, - and _)"
            aria-label="Server name"
            value={name}
            disabled={!!initial}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Select
            aria-label="Server type"
            allowDeselect={false}
            value={type}
            disabled={!!initial}
            data={[
              { value: 'stdio', label: 'Command (runs in the project container)' },
              { value: 'http', label: 'URL (streamable HTTP)' },
              { value: 'managed', label: 'Managed container (isolated, HTTP)' },
            ]}
            onChange={(v) => v && setType(v as Kind)}
          />
        </Group>
        <TextInput
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />

        {type === 'managed' && (
          <>
            <Text size="sm">
              Runs in its own container on a private network with no internet. The agent can call
              its tools but never sees its environment variables or files. The server must speak
              streamable HTTP at <code>/mcp</code>, and the image must already exist on this
              machine.
            </Text>
            <TextInput
              placeholder="Image, e.g. pi-panel/rea:6.8.0"
              value={image}
              onChange={(e) => setImage(e.currentTarget.value)}
            />
          </>
        )}

        {type === 'stdio' || type === 'managed' ? (
          <>
            <TextInput
              placeholder={
                type === 'managed' ? 'Command inside the container, e.g. rea' : 'Command, e.g. npx'
              }
              value={command}
              onChange={(e) => setCommand(e.currentTarget.value)}
            />
            <Textarea
              rows={3}
              placeholder={'Arguments, one per line\n-y\n@scope/server@1.2.3'}
              value={args}
              onChange={(e) => setArgs(e.currentTarget.value)}
              styles={{ input: mono }}
            />
            {type === 'stdio' && (
              <TextInput
                placeholder="Working directory (optional)"
                value={cwd}
                onChange={(e) => setCwd(e.currentTarget.value)}
              />
            )}
            {type === 'managed' && (
              <Group gap="md" wrap="wrap" align="flex-end">
                <NumberInput
                  label="Port"
                  min={1}
                  max={65535}
                  w={110}
                  value={port}
                  onChange={(v) => setPort(String(v))}
                />
                <NumberInput
                  label="Memory (MB)"
                  min={256}
                  max={32768}
                  w={130}
                  value={memoryMb}
                  onChange={(v) => setMemoryMb(String(v))}
                />
                <TextInput
                  label="Ready when logs contain"
                  value={readyLog}
                  placeholder="MCP transport listening"
                  onChange={(e) => setReadyLog(e.currentTarget.value)}
                />
                <Checkbox
                  label="Mount uploaded files at /samples (read-only)"
                  checked={mountSamples}
                  onChange={(e) => setMountSamples(e.currentTarget.checked)}
                />
              </Group>
            )}
            <Rows
              label={
                type === 'managed' ? 'Container environment (never sent to pi)' : 'Environment'
              }
              rows={env}
              onChange={setEnv}
              keyPlaceholder="NAME"
            />
          </>
        ) : (
          <>
            <TextInput
              placeholder="https://host/mcp  (a host service: http://host.docker.internal:PORT/mcp)"
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
            <Rows
              label="Headers"
              rows={headers}
              onChange={setHeaders}
              keyPlaceholder="Authorization"
            />
          </>
        )}

        <Group gap="md" wrap="wrap" align="flex-end">
          <Select
            label="Exposure"
            allowDeselect={false}
            w={320}
            value={exposure || EXPOSURE_DEFAULT}
            data={[
              { value: EXPOSURE_DEFAULT, label: 'pi default (codemode)' },
              { value: 'direct', label: 'direct: always shown to the model' },
              { value: 'deferred', label: 'deferred: found via tool search' },
              { value: 'codemode', label: 'codemode: called from scripts' },
              { value: 'hidden', label: 'hidden' },
            ]}
            onChange={(v) => setExposure(v === EXPOSURE_DEFAULT || !v ? '' : (v as McpExposure))}
          />
          <NumberInput
            label="Timeout (s)"
            min={1}
            max={600}
            w={110}
            value={timeout}
            onChange={(v) => setTimeoutSecs(String(v))}
          />
        </Group>

        <ErrorText error={error} />
        <Group gap="xs">
          <Button type="submit" disabled={busy || (!initial && !name.trim())}>
            {initial ? 'Save' : 'Add server'}
          </Button>
          <Button type="button" variant="default" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
