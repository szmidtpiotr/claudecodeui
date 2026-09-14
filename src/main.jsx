import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import './i18n/config.js'

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// Ask for persistent storage. The auth token lives in localStorage, and a
// mobile browser is free to evict a normal origin's storage under disk
// pressure — which logs the user out with nothing to show for it in any log.
// An installed PWA is usually granted this without a prompt; if it is denied
// the app still works, it is just evictable again.
if (navigator.storage?.persist) {
  navigator.storage.persisted?.().then(already => {
    if (!already) {
      return navigator.storage.persist();
    }
    return already;
  }).catch(err => {
    console.warn('Persistent storage request failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
