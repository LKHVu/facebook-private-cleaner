import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { formatErrorReport, toErrorRecord, type PopupErrorRecord } from './popupErrors';

interface Props {
  /** Names the region in the diagnostic box, e.g. "Developer / debug". */
  label: string;
  children: ReactNode;
}

interface State {
  error: PopupErrorRecord | null;
}

/**
 * Keeps a render error inside `children` from unmounting the whole popup (which leaves a
 * blank panel). Shows the error instead. Recording to localStorage happens in main.tsx
 * via createRoot's onCaughtError.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: toErrorRecord('ErrorBoundary', error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // getDerivedStateFromError has no access to the component stack.
    this.setState({ error: toErrorRecord(`ErrorBoundary: ${this.props.label}`, error, info.componentStack) });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorBox
        title={`${this.props.label} failed to render`}
        error={error}
        onDismiss={() => this.setState({ error: null })}
        dismissLabel="Try again"
      />
    );
  }
}

export function ErrorBox({
  title,
  error,
  onDismiss,
  dismissLabel,
}: {
  title: string;
  error: PopupErrorRecord;
  onDismiss?(): void;
  dismissLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatErrorReport(error));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked – the text is still selectable below
    }
  }

  return (
    <div className="error-box" role="alert">
      <p><strong>{title}</strong></p>
      <p className="break"><code>{error.name}</code>: {error.message}</p>
      <p className="muted small">Caught by {error.kind} at {new Date(error.at).toLocaleString()}</p>
      {error.componentStack && (
        <details>
          <summary className="small">Component stack</summary>
          <pre>{error.componentStack.trim()}</pre>
        </details>
      )}
      {error.stack && (
        <details>
          <summary className="small">JS stack</summary>
          <pre>{error.stack}</pre>
        </details>
      )}
      <div className="row">
        <button className="secondary small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy error'}</button>
        {onDismiss && <button className="secondary small" onClick={onDismiss}>{dismissLabel ?? 'Dismiss'}</button>}
      </div>
    </div>
  );
}
