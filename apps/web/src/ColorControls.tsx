import {
  ActionIcon,
  CheckIcon,
  ColorSwatch,
  Popover,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { IconDeviceDesktop, IconMoon, IconPalette, IconSun } from '@tabler/icons-react';
import { ACCENTS, type Accent } from './theme.js';
import { useAccent } from './ThemeRoot.js';

const label = (a: string) => a.charAt(0).toUpperCase() + a.slice(1);

const MODES = [
  { value: 'light', label: 'Light', icon: IconSun },
  { value: 'dark', label: 'Dark', icon: IconMoon },
  { value: 'auto', label: 'System', icon: IconDeviceDesktop },
];

/** Light / dark / system, and the accent color, behind one button. Remembered in this browser. */
export function ColorControls() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { accent, setAccent } = useAccent();
  return (
    <Popover position="bottom-end" width={248} shadow="md" radius="lg" withArrow>
      <Popover.Target>
        {/* Mantine's Tooltip forwards the popover's click handler and ref; the Tip wrapper would not. */}
        <Tooltip label="Appearance" openDelay={350}>
          <ActionIcon variant="default" size="lg" radius="md" aria-label="Appearance">
            <IconPalette size={18} stroke={1.6} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown p="md">
        <Stack gap="md">
          <Stack gap={6}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Theme
            </Text>
            <SegmentedControl
              fullWidth
              size="xs"
              aria-label="Colour scheme"
              value={colorScheme}
              onChange={(v) => setColorScheme(v as 'light' | 'dark' | 'auto')}
              data={MODES.map((m) => ({
                value: m.value,
                label: (
                  <Stack gap={2} align="center" py={2}>
                    <m.icon size={16} stroke={1.6} />
                    <span>{m.label}</span>
                  </Stack>
                ),
              }))}
            />
          </Stack>
          <Stack gap={6}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Accent
            </Text>
            <SimpleGrid cols={5} spacing={8} verticalSpacing={8}>
              {ACCENTS.map((a) => (
                <Tooltip key={a} label={label(a)} openDelay={250}>
                  <UnstyledButton
                    aria-label={`${label(a)} accent`}
                    aria-pressed={accent === a}
                    onClick={() => setAccent(a as Accent)}
                    style={{ display: 'flex', justifyContent: 'center' }}
                  >
                    <ColorSwatch
                      component="span"
                      color={`var(--mantine-color-${a}-6)`}
                      size={30}
                      c="white"
                    >
                      {accent === a && <CheckIcon size={12} />}
                    </ColorSwatch>
                  </UnstyledButton>
                </Tooltip>
              ))}
            </SimpleGrid>
          </Stack>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
