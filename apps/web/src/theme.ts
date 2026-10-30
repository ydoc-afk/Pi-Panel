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
  return createTheme({
    primaryColor: accent,
    defaultRadius: 'md',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    headings: { fontWeight: '650' },
    components: {
      Paper: { defaultProps: { shadow: 'xs' } },
      Card: { defaultProps: { shadow: 'sm' } },
      Button: { defaultProps: { fw: 500 } },
      Badge: { defaultProps: { fw: 600 } },
      NavLink: { defaultProps: { variant: 'light' }, styles: { root: { borderRadius: 8 } } },
    },
  });
}
