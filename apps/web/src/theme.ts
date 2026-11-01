import { createTheme, type MantineColorsTuple } from '@mantine/core';

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

/**
 * A cool slate for dark mode instead of Mantine's neutral grey. Mantine uses shade 7 for the page,
 * 6 for cards and inputs, and 4 for borders, so those three carry most of the look.
 */
const slate: MantineColorsTuple = [
  '#d5dae2',
  '#b3bac6',
  '#8a93a3',
  '#626c7d',
  '#353c49',
  '#272d38',
  '#1d222b',
  '#161a21',
  '#111419',
  '#0b0d11',
];

export function themeFor(accent: Accent) {
  return createTheme({
    primaryColor: accent,
    primaryShade: { light: 6, dark: 7 },
    colors: { dark: slate },
    defaultRadius: 'md',
    cursorType: 'pointer',
    fontFamily:
      '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    fontFamilyMonospace:
      'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
    headings: {
      fontWeight: '650',
      sizes: {
        h1: { fontSize: '1.875rem', lineHeight: '1.2' },
        h2: { fontSize: '1.5rem', lineHeight: '1.25' },
        h3: { fontSize: '1.2rem', lineHeight: '1.3' },
        h4: { fontSize: '1.05rem', lineHeight: '1.35' },
      },
    },
    shadows: {
      xs: '0 1px 2px rgb(16 24 40 / 0.05)',
      sm: '0 1px 3px rgb(16 24 40 / 0.08), 0 1px 2px rgb(16 24 40 / 0.04)',
      md: '0 6px 16px -4px rgb(16 24 40 / 0.1), 0 2px 6px -2px rgb(16 24 40 / 0.06)',
    },
    components: {
      Paper: { defaultProps: { shadow: 'xs', radius: 'md' } },
      Card: { defaultProps: { shadow: 'xs', radius: 'lg', withBorder: true } },
      Button: { defaultProps: { fw: 500 } },
      Badge: { defaultProps: { fw: 600, radius: 'sm' } },
      Tooltip: { defaultProps: { withArrow: true } },
      Modal: { defaultProps: { radius: 'lg', centered: true } },
      Accordion: { defaultProps: { radius: 'lg' } },
      NavLink: { defaultProps: { variant: 'light' }, styles: { root: { borderRadius: 8 } } },
    },
  });
}
