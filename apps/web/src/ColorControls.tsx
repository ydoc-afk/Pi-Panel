import { ColorSwatch, Group, SegmentedControl, Select, useMantineColorScheme } from '@mantine/core';
import { ACCENTS, type Accent } from './theme.js';
import { useAccent } from './ThemeRoot.js';

const MODES = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'auto' },
];

const label = (a: string) => a.charAt(0).toUpperCase() + a.slice(1);

/** Light / dark / system, and the accent color. Both are remembered in this browser. */
export function ColorControls() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { accent, setAccent } = useAccent();
  return (
    <Group gap="xs" wrap="nowrap">
      <Select
        aria-label="Accent color"
        size="xs"
        w={130}
        allowDeselect={false}
        value={accent}
        data={ACCENTS.map((a) => ({ value: a, label: label(a) }))}
        leftSection={<ColorSwatch color={`var(--mantine-color-${accent}-6)`} size={12} />}
        onChange={(v) => v && setAccent(v as Accent)}
      />
      <SegmentedControl
        size="xs"
        data={MODES}
        value={colorScheme}
        onChange={(v) => setColorScheme(v as 'light' | 'dark' | 'auto')}
      />
    </Group>
  );
}
