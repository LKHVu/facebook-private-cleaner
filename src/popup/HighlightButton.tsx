import { useState } from 'react';
import type { HighlightResponse, PopupRequest } from '../shared/types';

type HighlightStatus =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; outlined: string; details: string[] }
  | { kind: 'error'; message: string };

/** Asks the content script to outline something; a null `request` disables the button. */
export function HighlightButton({ request, label }: { request: PopupRequest | null; label: string }) {
  const [status, setStatus] = useState<HighlightStatus>({ kind: 'idle' });
  const disabled = request === null;

  async function highlight() {
    if (!request) return;
    setStatus({ kind: 'busy' });
    try {
      const res: HighlightResponse | undefined = await chrome.runtime.sendMessage(request);
      if (!res) throw new Error('No response from the background service worker.');
      setStatus(
        res.ok
          ? { kind: 'done', outlined: res.outlined, details: Array.isArray(res.details) ? res.details : [] }
          : { kind: 'error', message: res.error },
      );
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="highlight">
      <button className="secondary small" disabled={disabled || status.kind === 'busy'} onClick={highlight}>
        {label}
      </button>
      {status.kind === 'done' && <span className="ok small">Outlined {status.outlined} for 3 s</span>}
      {status.kind === 'done' &&
        status.details.map((d, i) => (
          <span key={i} className="muted small break">
            {d}
          </span>
        ))}
      {status.kind === 'error' && <span className="error small">{status.message}</span>}
    </div>
  );
}
