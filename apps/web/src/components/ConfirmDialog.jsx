import {useEffect, useRef} from 'react';

export function ConfirmDialog({title, children, confirmLabel, busy, onConfirm, onDismiss}) {
  const dialog = useRef(null);
  useEffect(() => {dialog.current?.showModal(); return () => dialog.current?.close();}, []);
  return <dialog className="confirm-dialog" ref={dialog} aria-labelledby="confirm-title" onCancel={event => {event.preventDefault(); if (!busy) onDismiss();}}><div className="confirm-dialog-copy"><p className="eyebrow">PLEASE CONFIRM</p><h2 id="confirm-title">{title}</h2>{children}</div><div className="confirm-actions"><button autoFocus className="button button-secondary" disabled={busy} onClick={onDismiss}>Keep it</button><button className="button button-danger" disabled={busy} onClick={onConfirm}>{busy ? 'Please wait…' : confirmLabel}</button></div></dialog>;
}
