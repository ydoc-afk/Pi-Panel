import type { ReactNode } from 'react';
import { Accordion, Group, Stack, Text, Title, Tooltip } from '@mantine/core';

/** Inline error message. Renders nothing when there is no error. */
export function ErrorText({ error }: { error: string }) {
  return error ? (
    <Text role="alert" c="red" size="sm">
      {error}
    </Text>
  ) : null;
}

/** Hover or focus hint for a control. Wrap one element, such as a Button. */
export function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip
      label={label}
      openDelay={350}
      multiline
      maw={260}
      withArrow
      events={{ hover: true, focus: true, touch: false }}
    >
      <span style={{ display: 'inline-flex' }}>{children}</span>
    </Tooltip>
  );
}

/** Page title with a one-line explanation and an optional action on the right. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" wrap="nowrap" mb="xs">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Title order={2}>{title}</Title>
        {description && (
          <Text size="sm" c="dimmed" maw={640}>
            {description}
          </Text>
        )}
      </Stack>
      {action}
    </Group>
  );
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
