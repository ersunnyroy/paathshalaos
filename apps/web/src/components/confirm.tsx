'use client';

import { useEffect, useState } from 'react';

/**
 * A button that asks once before it acts.
 *
 * Publishing a plan, retiring one, suspending a school and revoking somebody's
 * access cannot be taken back with an undo, and a browser `confirm()` is a
 * dialog people dismiss without reading. The first click arms the button and
 * changes what it says; the second does it. It disarms itself after a few
 * seconds so an armed button is never left waiting for a stray click.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, tone, disabled }: {
  label: string; confirmLabel: string; onConfirm: () => Promise<void> | void;
  tone?: 'critical'; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const handle = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(handle);
  }, [armed]);

  async function click() {
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); setArmed(false); }
  }

  return (
    <button type="button" onClick={click} disabled={disabled || busy}
            className={armed ? `armed${tone ? ` ${tone}` : ''}` : undefined}>
      {busy ? 'Working…' : armed ? confirmLabel : label}
    </button>
  );
}
