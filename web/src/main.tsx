import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './lib/install';
import { applyTheme } from './lib/theme';
import { fitToVisibleArea } from './lib/viewport';
import './styles.css';

applyTheme();
fitToVisibleArea();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
