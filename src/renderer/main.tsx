import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { getBridge } from './lib/bridge';
import './styles.css';
import './theme.css';

const host = document.getElementById('root');
if (host === null) throw new Error('Root element is missing');

const bridge = getBridge();
console.info('[renderer] boot', { mock: bridge.mock, bridgeVersion: bridge.bridgeVersion });

window.addEventListener('error', (event) => {
  console.error('[renderer] uncaught error', event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] unhandled rejection', event.reason);
});

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
