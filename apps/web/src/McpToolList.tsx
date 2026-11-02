import { Badge, Button, Checkbox, Group, Stack, Text } from '@mantine/core';
import type { McpTool } from './api.js';

/** A checkbox per tool: checked means the model can use it, unchecked hides it. */
export function McpToolList({
  tools,
  hidden,
  disabled,
  onChange,
}: {
  tools: McpTool[];
  hidden: string[];
  disabled?: boolean;
  onChange: (hidden: string[]) => void;
}) {
  const hiddenSet = new Set(hidden);
  const toggle = (name: string, visible: boolean) => {
    const next = new Set(hiddenSet);
    if (visible) next.delete(name);
    else next.add(name);
    onChange([...next]);
  };
  const shown = tools.filter((t) => !hiddenSet.has(t.name)).length;
  return (
    <Stack gap="xs" my="xs">
      {tools.length > 1 && (
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="default"
            disabled={disabled || shown === tools.length}
            onClick={() => onChange([])}
          >
            All
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            disabled={disabled || shown === 0}
            onClick={() => onChange(tools.map((t) => t.name))}
          >
            None
          </Button>
          <Text size="xs" c="dimmed">
            {shown} of {tools.length} enabled
          </Text>
        </Group>
      )}
      {tools.map((t) => (
        <Checkbox
          key={t.name}
          disabled={disabled}
          checked={!hiddenSet.has(t.name)}
          onChange={(e) => toggle(t.name, e.currentTarget.checked)}
          label={
            <>
              <Text span size="sm" ff="monospace">
                {t.name}
              </Text>
              {t.annotations.destructiveHint && (
                <Badge color="red" variant="light" size="xs" ml={6}>
                  destructive
                </Badge>
              )}
              {t.annotations.readOnlyHint && (
                <Badge color="green" variant="light" size="xs" ml={6}>
                  read-only
                </Badge>
              )}
              {t.description && (
                <Text span size="xs" c="dimmed">
                  {' '}
                  &mdash; {t.description}
                </Text>
              )}
            </>
          }
        />
      ))}
    </Stack>
  );
}
