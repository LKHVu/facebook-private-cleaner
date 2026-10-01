/**
 * Diagnostic only (temporary): remembers the latest popup error in localStorage so it can
 * be shown the next time the popup opens. Popups close on blur and take their DevTools
 * console with them, so otherwise a crash leaves no trace.
 */

export interface PopupErrorRecord {
  at: string;
  /** Where it was caught, e.g. "window.error" or "ErrorBoundary: Developer / debug". */
  kind: string;
  name: string;
  message: string;
  stack: string | null;
  componentStack: string | null;
}

const STORAGE_KEY = 'fpc:lastPopupError';

export function toErrorRecord(kind: string, error: unknown, componentStack?: string | null): PopupErrorRecord {
  const base = { at: new Date().toISOString(), kind, componentStack: componentStack || null };
  if (error instanceof Error) {
    return { ...base, name: error.name, message: error.message, stack: error.stack ?? null };
  }
  let message: string;
  try {
    message = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    message = String(error);
  }
  return { ...base, name: `Non-Error thrown (${typeof error})`, message, stack: null };
}

export function formatErrorReport(r: PopupErrorRecord): string {
  return [
    `${r.name}: ${r.message}`,
    `Caught by: ${r.kind}`,
    `At: ${r.at}`,
    r.stack ? `\nStack:\n${r.stack}` : '',
    r.componentStack ? `\nComponent stack:${r.componentStack}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function recordPopupError(kind: string, error: unknown, componentStack?: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toErrorRecord(kind, error, componentStack)));
  } catch {
    // storage unavailable – nothing else we can do from inside an error handler
  }
}

export function readLastPopupError(): PopupErrorRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PopupErrorRecord) : null;
  } catch {
    return null;
  }
}

export function clearLastPopupError(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function installGlobalErrorListeners(): void {
  window.addEventListener('error', (e) => recordPopupError('window.error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => recordPopupError('unhandledrejection', e.reason));
}
