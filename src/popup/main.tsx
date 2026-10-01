import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Tester } from './Tester';
import { ErrorBoundary } from './ErrorBoundary';
import { installGlobalErrorListeners, recordPopupError } from './popupErrors';
import './popup.css';

// Diagnostic only (temporary): keep the latest error so it survives the popup closing.
installGlobalErrorListeners();

// popup/index.html is the toolbar popup; popup/tester.html (data-mode="tester") the persistent tester window.
const tester = document.body.dataset.mode === 'tester';

createRoot(document.getElementById('root')!, {
  // Supplying these replaces React's default reporting, so log to the console as well.
  onCaughtError(error, info) {
    recordPopupError('React ErrorBoundary', error, info.componentStack);
    console.error(error);
  },
  onUncaughtError(error, info) {
    recordPopupError('React (uncaught)', error, info.componentStack);
    console.error(error);
  },
}).render(
  <StrictMode>
    <ErrorBoundary label={tester ? 'Tester' : 'Popup'}>
      {tester ? <Tester /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
