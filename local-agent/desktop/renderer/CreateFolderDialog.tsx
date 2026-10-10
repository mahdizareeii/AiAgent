import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { workspaceNameError } from '../workspace-name';
import Icon from './Icons';

export default function CreateFolderDialog({ busy, error, onCreate, onClose, onKeyDown }: {
  busy: boolean;
  error: string | null;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const validationError = workspaceNameError(name);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return <div className="modal-backdrop" onKeyDown={event => onKeyDown(event, dialogRef.current)}>
    <section className="folder-dialog" role="dialog" aria-modal="true" aria-labelledby="create-folder-title" ref={dialogRef}>
      <div className="tools-dialog-header"><h2 id="create-folder-title">Create workspace folder</h2><button className="icon-button" disabled={busy} aria-label="Close create folder" onClick={onClose}><Icon name="close" size={18} /></button></div>
      <p className="muted">Name your workspace, then choose its location. The agent will work inside the new folder.</p>
      <form onSubmit={event => { event.preventDefault(); if (!busy && !validationError) void onCreate(name); }}>
        <label className="folder-name-label" htmlFor="workspace-folder-name">Folder name</label>
        <input ref={inputRef} id="workspace-folder-name" value={name} disabled={busy} maxLength={255} autoComplete="off" spellCheck={false} placeholder="my-project" aria-invalid={!!name && !!validationError} aria-describedby="folder-name-help" onChange={event => setName(event.target.value)} />
        <p id="folder-name-help" className={name && validationError ? 'inline-error' : 'muted'}>{name && validationError ? validationError : 'Existing folders are never replaced.'}</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy || !!validationError}><Icon name="folder" size={16} />{busy ? 'Choosing location…' : 'Create folder'}</button></div>
      </form>
    </section>
  </div>;
}
