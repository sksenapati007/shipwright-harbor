import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app';
import './style.css';

// Feature modules self-register their panels (see lib/panels.ts).
import.meta.glob('./features/*/index.{ts,tsx}', { eager: true });

const root = document.getElementById('app');
if (root) render(<App />, root);

// Offline: precache everything after first load. No update prompt; autoUpdate.
if ('serviceWorker' in navigator) registerSW({ immediate: true });
