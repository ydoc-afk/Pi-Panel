import { createContext, useContext, type ReactNode } from 'react';
import {
  Accordion,
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  type MantineColor,
} from '@mantine/core';
import type { Icon } from '@tabler/icons-react';

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

/** Page title with an icon, a one-line explanation and an optional action on the right. */
export function PageHeader({
  title,
  description,
  action,
  icon: IconCmp,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: Icon;
}) {
  return (
    <Group justify="space-between" align="flex-end" gap="md" mb="xs">
      <Group gap="md" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 320px' }}>
        {IconCmp && (
          <ThemeIcon variant="light" size={44} radius="md">
            <IconCmp size={24} stroke={1.6} />
          </ThemeIcon>
        )}
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Title order={2} style={{ letterSpacing: '-0.015em' }}>
            {title}
          </Title>
          {description && (
            <Text size="sm" c="dimmed" maw={680}>
              {description}
            </Text>
          )}
        </Stack>
      </Group>
      {action}
    </Group>
  );
}

/** A friendly placeholder for a list with nothing in it yet. */
export function EmptyState({
  icon: IconCmp,
  title,
  children,
  action,
}: {
  icon: Icon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Paper
      withBorder
      shadow="none"
      radius="lg"
      p="xl"
      style={{ borderStyle: 'dashed', background: 'transparent' }}
    >
      <Stack align="center" gap="xs" py="md">
        <ThemeIcon variant="light" size={52} radius="xl">
          <IconCmp size={26} stroke={1.5} />
        </ThemeIcon>
        <Text fw={600}>{title}</Text>
        {children && (
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            {children}
          </Text>
        )}
        {action}
      </Stack>
    </Paper>
  );
}

const STATUS_COLORS: Record<string, MantineColor> = {
  running: 'green',
  connected: 'green',
  approved: 'green',
  idle: 'gray',
  stopped: 'gray',
  creating: 'yellow',
  pending: 'orange',
  starting: 'yellow',
  error: 'red',
  failed: 'red',
  exited: 'red',
  rejected: 'gray',
};

/** A status word with a coloured dot: green for running, red for errors, and so on. */
export function StatusBadge({ status, color }: { status: string; color?: MantineColor }) {
  return (
    <Badge variant="dot" color={color ?? STATUS_COLORS[status] ?? 'gray'} tt="none" fw={500}>
      {status}
    </Badge>
  );
}

/**
 * Inside a tab, a top-level section does not need its own fold-away header: the tab names it.
 * Sections nested deeper still fold.
 */
const FlatSections = createContext(false);

export function FlatSection({ children }: { children: ReactNode }) {
  return <FlatSections.Provider value={true}>{children}</FlatSections.Provider>;
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
  const flat = useContext(FlatSections);
  if (flat) {
    return (
      <FlatSections.Provider value={false}>
        <Paper withBorder radius="lg" p="lg">
          <Stack gap="md">
            <Text fw={650} size="lg">
              {title}
            </Text>
            {children}
          </Stack>
        </Paper>
      </FlatSections.Provider>
    );
  }
  return (
    <Accordion variant="separated" radius="lg" defaultValue={defaultOpen ? 'open' : null}>
      <Accordion.Item value="open">
        <Accordion.Control fw={600}>{title}</Accordion.Control>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export const mono = { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } as const;
