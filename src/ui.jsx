import { useCallback, useState } from 'react';
import { words } from './words.js';

// runs single action at a time: button disable while run; failure stays on screen
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (action) => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(err.message ?? String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <p className="error" role="alert">{error}</p>;
}

export function Notice({ children }) {
  return <p className="notice" role="status">{children}</p>;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// iso strings from api shown in the reader's timezone
export function Time({ iso }) {
  return <time dateTime={iso}>{dateFormat.format(new Date(iso))}</time>;
}

export function TierSelect({ id, label, value, onChange, disabled }) {
  return (
    <label className="field inline" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {Object.entries(words.tiers).map(([tier, name]) => <option key={tier} value={tier}>{name}</option>)}
      </select>
    </label>
  );
}

export function Loading() {
  return <p className="quiet" role="status">loading...</p>;
}
