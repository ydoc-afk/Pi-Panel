import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core';
import { ACCENTS, DEFAULT_ACCENT, themeFor, type Accent } from './theme.js';

const ACCENT_KEY = 'pi-panel-accent';
const SCHEME_KEY = 'pi-panel-color-scheme';

// 'auto' follows the operating system; the choice is remembered per browser.
const colorSchemeManager = localStorageColorSchemeManager({ key: SCHEME_KEY });

function loadAccent(): Accent {
  try {
    const stored = window.localStorage.getItem(ACCENT_KEY);
    return (ACCENTS as readonly string[]).includes(stored ?? '')
      ? (stored as Accent)
      : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

const AccentContext = createContext<{ accent: Accent; setAccent: (a: Accent) => void }>({
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
});

export const useAccent = () => useContext(AccentContext);

export function ThemeRoot({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<Accent>(loadAccent);
  const theme = useMemo(() => themeFor(accent), [accent]);

  const setAccent = (next: Accent) => {
    setAccentState(next);
    try {
      window.localStorage.setItem(ACCENT_KEY, next);
    } catch {
      // Storage is unavailable (private window, blocked): the choice lasts for this page only.
    }
  };

  return (
    <AccentContext.Provider value={{ accent, setAccent }}>
      <MantineProvider
        theme={theme}
        defaultColorScheme="auto"
        colorSchemeManager={colorSchemeManager}
      >
        {children}
      </MantineProvider>
    </AccentContext.Provider>
  );
}
