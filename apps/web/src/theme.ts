import { createTheme } from '@mantine/core';

/** Accent palettes a viewer can pick. Each is a Mantine color with its own shades. */
export const ACCENTS = [
  'teal',
  'blue',
  'cyan',
  'green',
  'violet',
  'grape',
  'indigo',
  'orange',
  'pink',
  'red',
] as const;

export type Accent = (typeof ACCENTS)[number];

export const DEFAULT_ACCENT: Accent = 'teal';

export function themeFor(accent: Accent) {
  return createTheme({ primaryColor: accent, defaultRadius: 'md' });
}
