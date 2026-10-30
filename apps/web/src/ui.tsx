import type { ReactNode } from 'react';
import { Accordion, Text } from '@mantine/core';

/** Inline error message. Renders nothing when there is no error. */
export function ErrorText({ error }: { error: string }) {
  return error ? (
    <Text role="alert" c="red" size="sm">
      {error}
    </Text>
  ) : null;
}

/** A titled section that can be folded away. */
export function Collapsible({
  title,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Accordion variant="separated" radius="md" defaultValue={defaultOpen ? 'open' : null}>
      <Accordion.Item value="open">
        <Accordion.Control fw={600}>{title}</Accordion.Control>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export const mono = { fontFamily: 'ui-monospace, monospace', fontSize: 13 } as const;
