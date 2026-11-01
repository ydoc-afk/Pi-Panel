import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@mantine/core/styles.css';
import './app.css';
import { App } from './App.js';
import { ThemeRoot } from './ThemeRoot.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeRoot>
      <App />
    </ThemeRoot>
  </StrictMode>,
);
