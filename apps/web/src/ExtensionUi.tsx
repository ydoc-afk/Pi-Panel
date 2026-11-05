import { useEffect, useState } from 'react';
import { Button, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { getStatus, respondUi } from './api.js';
import type { UiDialog, UiState } from './transcript.js';
import { ErrorText } from './ui.js';

/** Whether the signed-in user is the admin; read once. Treated as no until it is known. */
let adminCheck: Promise<boolean> | undefined;
const checkAdmin = () =>
  (adminCheck ??= getStatus().then(
    (s) => s.user?.role === 'admin',
    () => false,
  ));

/** The question the oldest open extension dialog asks; closing it declines. */
export function ExtensionDialog({
  sessionId,
  dialog,
}: {
  sessionId: number;
  dialog: UiDialog | undefined;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    void checkAdmin().then(setAdmin);
  }, []);

  useEffect(() => {
    setText(dialog?.prefill ?? '');
    setError('');
    setBusy(false);
  }, [dialog?.id, dialog?.prefill]);

  async function answer(a: { value: string } | { confirmed: boolean } | { cancelled: true }) {
    if (!dialog || busy) return;
    setBusy(true);
    setError('');
    try {
      await respondUi(sessionId, { id: dialog.id, ...a });
    } catch (err) {
      // The server retires the dialog when it is answered or times out; a refusal here usually
      // means it already was, and the resolved event will close this modal.
      setError(err instanceof Error ? err.message : 'Could not send the answer');
      setBusy(false);
    }
  }

  return (
    <Modal
      opened={!!dialog}
      onClose={() => void answer({ cancelled: true })}
      title={dialog?.title || 'An extension has a question'}
      centered
      closeOnClickOutside={false}
    >
      {dialog && (
        <Stack gap="sm">
          {dialog.message && (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {dialog.message}
            </Text>
          )}
          {dialog.method === 'select' && (
            <Stack gap={6}>
              {(dialog.options ?? []).map((o) => (
                <Button
                  key={o}
                  variant="light"
                  justify="flex-start"
                  disabled={busy}
                  onClick={() => void answer({ value: o })}
                >
                  {o}
                </Button>
              ))}
            </Stack>
          )}
          {dialog.method === 'input' && (
            <TextInput
              autoFocus
              value={text}
              placeholder={dialog.placeholder}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void answer({ value: text });
              }}
            />
          )}
          {dialog.method === 'editor' && (
            <Textarea
              autoFocus
              autosize
              minRows={6}
              maxRows={16}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              styles={{ input: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } }}
            />
          )}
          {dialog.method === 'confirm' && dialog.adminOnly && !admin && (
            <Text size="sm" c="dimmed">
              Only the admin can approve this. You can decline it.
            </Text>
          )}
          <ErrorText error={error} />
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              disabled={busy}
              onClick={() => void answer({ cancelled: true })}
            >
              {dialog.method === 'confirm' ? 'No' : 'Cancel'}
            </Button>
            {dialog.method === 'confirm' && (!dialog.adminOnly || admin) && (
              <Button disabled={busy} onClick={() => void answer({ confirmed: true })}>
                Yes
              </Button>
            )}
            {(dialog.method === 'input' || dialog.method === 'editor') && (
              <Button disabled={busy} onClick={() => void answer({ value: text })}>
                OK
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

const widgetStyle = (dim: string, border: string) =>
  ({
    margin: '4px 0 4px 12px',
    padding: '4px 8px',
    borderLeft: `2px solid ${border}`,
    color: dim,
    whiteSpace: 'pre-wrap',
    fontSize: 12.5,
  }) as const;

/** Widgets extensions place above or below the prompt line. */
export function ExtensionWidgets({
  ui,
  placement,
  dim,
  border,
}: {
  ui: UiState;
  placement: 'above' | 'below';
  dim: string;
  border: string;
}) {
  const shown = Object.entries(ui.widgets).filter(
    ([, w]) => w.placement === placement && w.lines.length,
  );
  if (!shown.length) return null;
  return (
    <>
      {shown.map(([key, w]) => (
        <div key={key} style={widgetStyle(dim, border)}>
          {w.lines.join('\n')}
        </div>
      ))}
    </>
  );
}

/** Status entries extensions set, as one dim line. */
export function ExtensionStatus({ ui }: { ui: UiState }) {
  const entries = Object.entries(ui.statuses);
  if (!entries.length) return null;
  return (
    <Text size="xs" c="dimmed" style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
      {entries.map(([, text]) => text).join('  ·  ')}
    </Text>
  );
}
