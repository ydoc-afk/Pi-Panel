import { useEffect, useState } from 'react';
import { Button, Group, Modal, Text } from '@mantine/core';

interface Request {
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

let show: ((request: Request | null) => void) | undefined;

/**
 * Asks the user to confirm with the panel's own dialog. The browser's confirm() is not used: it can
 * be switched off for a page ("prevent additional dialogs") or be missing in embedded browsers, and
 * then it returns false without showing anything, so a delete button appears to do nothing.
 */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) {
      resolve(false); // the host is not mounted: refuse rather than act unconfirmed
      return;
    }
    // The first word of the message names the action ("Delete ...", "Remove ...", "Disconnect ...").
    const verb = /^(Delete|Remove|Disconnect|Replace|Stop)\b/.exec(message)?.[1];
    show({ message, confirmLabel: verb ?? 'Confirm', resolve });
  });
}

/** Renders the dialog askConfirm opens. Mount once, inside the Mantine provider. */
export function ConfirmHost() {
  const [request, setRequest] = useState<Request | null>(null);

  useEffect(() => {
    show = (next) => {
      // A newer question replaces an unanswered one, which counts as "no".
      setRequest((prev) => {
        prev?.resolve(false);
        return next;
      });
    };
    return () => {
      show = undefined;
    };
  }, []);

  const finish = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  return (
    <Modal
      opened={!!request}
      onClose={() => finish(false)}
      title="Please confirm"
      centered
      size="sm"
    >
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {request?.message}
      </Text>
      <Group justify="flex-end" gap="xs" mt="md">
        <Button variant="default" onClick={() => finish(false)}>
          Cancel
        </Button>
        <Button color="red" data-autofocus onClick={() => finish(true)}>
          {request?.confirmLabel}
        </Button>
      </Group>
    </Modal>
  );
}
