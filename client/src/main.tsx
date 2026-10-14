import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import AdminApp from './admin/AdminApp';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

/**
 * Two apps, one bundle: `/admin` is the owner's dashboard, everything else is
 * the chat app. No router on purpose — the chat app is a state machine, and
 * one pathname check is all the routing a single-page deployment like this
 * has ever needed. The server's SPA fallback serves `index.html` for
 * `/admin`, so the deep link survives a reload.
 */
const isAdmin = window.location.pathname.startsWith('/admin');

createRoot(container).render(
  <StrictMode>{isAdmin ? <AdminApp /> : <App />}</StrictMode>,
);
