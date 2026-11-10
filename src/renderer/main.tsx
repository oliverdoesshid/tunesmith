import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('Root element is missing');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
