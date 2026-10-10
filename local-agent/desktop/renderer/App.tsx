import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Icon from './Icons';
import ModelSetup from './ModelSetup';
import Utilities from './Utilities';
import type { AgentEvent, AgentStatus, Attachment, ChatMessage, DownloadProgress, Mode, PermissionRequest, StageProgress, ToolActivity, UtilityPreferences } from './types';

const modes: { id: Mode; name: string; icon: 'code' | 'search' | 'spark'; description: string; examples: string[] }[] = [
  { id: 'coding', name: 'Coding', icon: 'code', description: 'Build, explore, and improve your code.', examples: ['Explore this project and explain its architecture', 'Help me find and fix a bug', 'Review my changes before I commit'] },
  { id: 'research', name: 'Research', icon: 'search', description: 'Explore questions with sources you can review.', examples: ['Research a topic and compare reliable sources', 'Summarize a document I attach', 'Compare approaches and explain the tradeoffs'] },
  { id: 'assistant', name: 'Assistant', icon: 'spark', description: 'Write, plan, and work through ideas.', examples: ['Help me work through an idea', 'Turn these notes into a clear plan', 'Explain something step by step'] },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function folderName(path?: string) {
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Choose a folder';
}

function modelIsUsable(status: AgentStatus | null) {
  const model = status?.models.find((item) => item.id === status.selectedModel);
  return !!status?.runtime.ready && !!model?.installed && !model.blockedReason && model.fit !== 'insufficient' && (model.fit !== 'slow' || status.slowMode);
}

function trapDialogFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== 'Tab') return;
  const focusable = [...(container?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]') ?? [])];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

function PermissionDialog({ request, onRespond }: { request: PermissionRequest; onRespond: (approved: boolean) => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { denyRef.current?.focus(); }, [request.requestId]);

  async function respond(approved: boolean) {
    setSubmitting(true);
    setError(null);
    try { await onRespond(approved); } catch (reason) { setError(errorMessage(reason)); setSubmitting(false); }
  }

  return <div className="modal-backdrop" onKeyDown={(event) => {
    if (event.key === 'Escape' && !submitting) void respond(false);
    trapDialogFocus(event, dialogRef.current);
  }}>
    <div className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title" ref={dialogRef}>
      <div className="dialog-symbol"><Icon name="shield" size={24} /></div>
      <p className="eyebrow">YOUR APPROVAL</p>
      <h2 id="permission-title">{request.title || 'Review this action'}</h2>
      <p className="muted">Review the action before Free Local Agent continues. Your choice applies to this action only.</p>
      {request.cwd && <div className="review-location"><Icon name="folder" size={15} /><span>{request.cwd}</span></div>}
      {request.command && <section className="review-block"><h3>Command</h3><pre>{request.command}</pre></section>}
      {request.preview !== undefined && <section className="review-block"><h3>Proposed change</h3><pre className="diff-preview">{displayValue(request.preview)}</pre></section>}
      <details className="review-block" open={!request.command && request.preview === undefined}><summary>Action details</summary><pre>{displayValue(request.arguments)}</pre></details>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" ref={denyRef} disabled={submitting} onClick={() => void respond(false)}>Deny</button><button className="primary-button" disabled={submitting} onClick={() => void respond(true)}><Icon name="check" size={17} />{submitting ? 'Responding…' : 'Approve once'}</button></div>
    </div>
  </div>;
}

export default function App() {
  const bridge = window.localAgent;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [calibrating, setCalibrating] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const [stage, setStage] = useState<StageProgress | null>(null);
  const [mode, setMode] = useState<Mode>('coding');
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const loadingSessionRef = useRef(false);
  const downloadCancelRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const setupRef = useRef<HTMLDivElement>(null);
  const chosenMode = modes.find((item) => item.id === mode) ?? modes[0];
  const selectedModel = status?.models.find((model) => model.id === status.selectedModel);
  const ready = modelIsUsable(status);
  const webActive = mode === 'research' && !!status?.utilities.webResearch && selectedModel?.toolCapable !== false;

  const refresh = useCallback(async () => {
    if (!bridge) throw new Error('The desktop connection is unavailable. Launch Free Local Agent as a desktop app to connect to its local runtime.');
    const next = await bridge.status();
    setStatus(next);
    return next;
  }, [bridge]);

  useEffect(() => {
    let live = true;
    refresh().then((next) => {
      if (!live) return;
      setMode(next.mode);
      setProjectPath(next.projectPath);
      if (!modelIsUsable(next)) setSetupOpen(true);
    }).catch((reason) => { if (live) setError(errorMessage(reason)); });

    const unsubscribe = bridge?.onEvent((event: AgentEvent) => {
      if (event.type === 'status') { void refresh().catch((reason) => setError(errorMessage(reason))); return; }
      if (event.type === 'download') { setDownload(event); return; }
      if (event.sessionId && event.sessionId !== sessionRef.current) return;
      if (event.type === 'stage') { setStage(event); return; }
      if (event.type === 'message') {
        if (event.thinking) { setThinking(true); return; }
        setThinking(false);
        setMessages((current) => {
          const last = current.at(-1);
          return last?.role === 'assistant' ? [...current.slice(0, -1), { ...last, content: last.content + event.text }] : [...current, { role: 'assistant', content: event.text }];
        });
      } else if (event.type === 'tool') {
        setThinking(false);
        setTools((current) => current.some((tool) => tool.id === event.id) ? current.map((tool) => tool.id === event.id ? { ...tool, ...event } : tool) : [...current, event]);
      } else if (event.type === 'permission') {
        setPermissions((current) => current.some((request) => request.requestId === event.requestId) ? current : [...current, event]);
      } else if (event.type === 'done') {
        setThinking(false); setPermissions([]);
        setStage((current) => current?.resumable ? current : null);
        void refresh().catch((reason) => setError(errorMessage(reason)));
      } else if (event.type === 'error') {
        setError(event.text ?? event.error ?? 'Something went wrong. Please try again.');
        if (event.sessionId) {
          setThinking(false); setPermissions([]);
          setStage((current) => current?.resumable ? current : null);
        }
      }
    });
    return () => { live = false; unsubscribe?.(); };
  }, [bridge, refresh]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, busy, tools]);
  useEffect(() => {
    if (!setupOpen) return;
    setupRef.current?.querySelector<HTMLElement>('button:not(:disabled), summary')?.focus();
  }, [setupOpen]);
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 180)}px`;
  }, [draft]);

  async function action(operation: () => Promise<unknown>) {
    setError(null);
    try { await operation(); } catch (reason) { setError(errorMessage(reason)); }
  }

  function newChat(nextMode = mode) {
    if (busyRef.current || loadingSessionRef.current) return;
    setSessionId(null); sessionRef.current = null;
    setMode(nextMode); setMessages([]); setTools([]); setFiles([]); setDraft(''); setError(null); setNotice(null); setStage(null);
    inputRef.current?.focus();
  }

  async function loadSession(id: string) {
    if (!bridge || busyRef.current || loadingSessionRef.current) return;
    loadingSessionRef.current = true;
    setLoadingSession(true); setError(null);
    try {
      const loaded = await bridge.loadSession(id);
      setSessionId(loaded.id); sessionRef.current = loaded.id;
      setMessages(loaded.messages); setMode(loaded.mode); setProjectPath(loaded.projectPath); setTools([]); setFiles([]); setDraft(''); setStage(loaded.stage ?? null);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { loadingSessionRef.current = false; setLoadingSession(false); }
  }

  async function synchronizeSession(id: string) {
    if (!bridge || sessionRef.current !== id) return;
    const loaded = await bridge.loadSession(id);
    if (sessionRef.current !== id) return;
    setMessages(loaded.messages);
    setStage(loaded.stage?.resumable ? loaded.stage : null);
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!bridge || !ready || !text || busyRef.current || loadingSessionRef.current || download || calibrating || importing || settingsBusy || setupBusy) return;
    if (mode === 'coding' && !projectPath) { setError('Choose a project folder to start a coding chat.'); return; }
    if (files.length && !status?.utilities.fileReading) { setError('Enable Read files in Tools to use your attached files.'); return; }
    setError(null); setNotice(null); setBusy(true); busyRef.current = true; setThinking(false); setTools([]); setStage({ stage: 'preparing', message: 'Preparing your local task' });
    let started = false;
    try {
      let currentId = sessionRef.current;
      if (!currentId) {
        const created = await bridge.createSession({ mode, projectPath });
        currentId = created.id;
        sessionRef.current = currentId; setSessionId(currentId);
      }
      setMessages((current) => [...current, { role: 'user', content: text + (files.length ? `\n\nAttached: ${files.map((file) => file.name).join(', ')}` : '') }]);
      setDraft(''); setFiles([]); started = true;
      await bridge.send({ sessionId: currentId, text, ...(files.length ? { files } : {}) });
      await refresh();
    } catch (reason) { setError(errorMessage(reason)); if (started) setDraft(text); }
    finally {
      setStage((current) => current?.resumable ? current : null);
      if (sessionRef.current) await synchronizeSession(sessionRef.current).catch((reason) => setError((current) => current ?? errorMessage(reason)));
      setBusy(false); busyRef.current = false; setThinking(false); setPermissions([]); inputRef.current?.focus();
    }
  }

  async function checkRuntime() {
    if (!bridge) return;
    setSetupBusy(true); setError(null);
    try {
      const next = await bridge.setup({});
      setStatus(next);
      if (!next.runtime.ready) setError(next.runtime.error ?? 'The bundled runtime could not start. Please retry.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSetupBusy(false); }
  }

  async function downloadModel(id: string) {
    if (!bridge) return;
    downloadCancelRef.current = false;
    setError(null); setDownload({ modelId: id, progress: { status: 'Starting download' } });
    try { await bridge.downloadModel(id); await refresh(); }
    catch (reason) {
      const message = errorMessage(reason);
      if (downloadCancelRef.current && /cancelled|canceled|aborted/i.test(message)) setNotice('Download canceled. You can retry it when you’re ready.');
      else setError(message);
    }
    finally { setDownload(null); }
  }

  async function cancelDownload() {
    if (!bridge) return;
    downloadCancelRef.current = true;
    await action(() => bridge.cancelDownload());
  }

  async function importModel() {
    if (!bridge) return;
    setImporting(true); setError(null);
    try { await bridge.importModel(); await refresh(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setImporting(false); }
  }

  async function calibrateModel(id: string) {
    if (!bridge) return;
    setCalibrating(id); setError(null);
    try {
      await bridge.calibrateModel(id);
      const next = await refresh();
      const model = next.models.find((item) => item.id === id);
      setNotice(model?.measuredTokensPerSecond !== undefined ? `Calibration: ${model.measuredTokensPerSecond.toFixed(1)} tokens/sec on this computer.` : 'Calibration finished.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setCalibrating(null); }
  }

  async function settingsAction(operation: () => Promise<void>) {
    setSettingsBusy(true); setError(null);
    try { await operation(); await refresh(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setSettingsBusy(false); }
  }

  async function setUtilities(preferences: UtilityPreferences) {
    if (bridge) await settingsAction(() => bridge.setUtilities(preferences));
  }

  async function resumeTask() {
    const id = sessionRef.current;
    if (!id || !bridge || !ready || busyRef.current || loadingSessionRef.current) return;
    setError(null); setBusy(true); busyRef.current = true; setThinking(false); setPermissions([]); setTools([]);
    setStage({ stage: 'resuming', message: 'Resuming from the saved checkpoint' });
    try {
      await bridge.resume(id);
      await refresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally {
      setStage((current) => current?.resumable ? current : null);
      await synchronizeSession(id).catch((reason) => setError((current) => current ?? errorMessage(reason)));
      setBusy(false); busyRef.current = false; setThinking(false); setPermissions([]);
    }
  }

  async function respondPermission(approved: boolean) {
    const request = permissions[0];
    if (!bridge || !request) return;
    await bridge.respondPermission({ requestId: request.requestId, approved });
    setPermissions((current) => current.filter((item) => item.requestId !== request.requestId));
  }

  const selectedModelName = selectedModel?.name ?? 'Choose a model';
  const locked = busy || loadingSession || !!download || !!calibrating || importing || settingsBusy || setupBusy;

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Chat navigation">
      <div className="brand"><span className="brand-mark"><Icon name="brand" size={21} /></span><span><span className="brand-name">Free<span className="brand-name-secondary">Local Agent</span></span><span className="brand-tag">YOUR AI. YOUR FREEDOM.</span></span></div>
      <button className="new-chat" disabled={locked} onClick={() => newChat()}><Icon name="plus" size={18} />New chat<span className="key-hint">+</span></button>
      <div className="sidebar-heading">YOUR CHATS<span>{status?.sessions.length || ''}</span></div>
      <nav className="session-list" aria-label="Saved chats">
        {!status?.sessions.length && <p className="empty-history">Your conversations stay here,<br />on this computer.</p>}
        {status?.sessions.map((session) => <button key={session.id} className={`session-item ${sessionId === session.id ? 'selected' : ''}`} disabled={locked} onClick={() => void loadSession(session.id)} title={session.title}><Icon name="chat" size={16} /><span>{session.title || 'Untitled chat'}</span>{session.resumable && <small className="session-paused">Paused</small>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="sidebar-link" disabled={locked} onClick={() => setSetupOpen(true)}><Icon name="settings" size={17} />Models & setup<Icon name="chevron" size={14} /></button>
        <div className="local-badge"><span className={`status-dot ${ready ? 'online' : ''}`} /><div><strong>{ready ? 'Running locally' : 'Setup needed'}</strong><span>{ready ? 'Your model. Your computer.' : 'Connect a local model to begin.'}</span></div><Icon name="monitor" size={17} /></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={13} /><strong>{sessionId ? status?.sessions.find((session) => session.id === sessionId)?.title || 'Conversation' : 'New conversation'}</strong></div>
        <div className="header-actions"><button className="text-button undo-button" disabled={locked || !bridge} onClick={() => void action(async () => { const result = await bridge!.undo(); setNotice(result.restored ? `Restored ${result.restored} file${result.restored === 1 ? '' : 's'}.` : 'No file changes to undo.'); })} title="Undo the most recent file change"><Icon name="undo" size={16} />Undo change</button><span className="offline-label"><Icon name="shield" size={14} />LOCAL INFERENCE</span></div>
      </header>

      <div className="conversation-controls">
        <div className="mode-tabs" role="group" aria-label="Agent mode">{modes.map((item) => <button key={item.id} aria-pressed={mode === item.id} className={mode === item.id ? 'active' : ''} disabled={locked} onClick={() => mode !== item.id && newChat(item.id)}><Icon name={item.icon} size={15} />{item.name}</button>)}</div>
        <div className="workspace-controls"><button className={`tools-toggle ${utilitiesOpen ? 'active' : ''}`} disabled={!status} onClick={() => setUtilitiesOpen((current) => !current)} aria-expanded={utilitiesOpen} aria-controls="utility-panel"><Icon name="settings" size={14} />Tools</button><button className={`project-button ${projectPath ? 'has-project' : ''}`} disabled={locked || !bridge || !!sessionId} title={projectPath ?? 'Choose a project folder'} onClick={() => void action(async () => { const selected = await bridge!.selectProject(); if (selected) setProjectPath(selected); })}><Icon name="folder" size={16} /><span>{folderName(projectPath)}</span><Icon name="chevron" size={12} /></button></div>
      </div>
      {utilitiesOpen && status && <section className="utility-panel" id="utility-panel" aria-label="Tool controls"><div className="utility-panel-heading"><h2>Choose the tools for your next task</h2><span>{selectedModel?.toolCapable === false ? 'Chat model · agent tools unavailable' : webActive ? 'Web research uses the internet' : mode === 'research' ? 'Web research is off' : `${chosenMode.name} mode`}</span></div><Utilities preferences={status.utilities} mode={mode} toolCapable={selectedModel?.toolCapable} disabled={locked || !bridge} onChange={setUtilities} /></section>}

      {error && !setupOpen && <div className="banner error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><Icon name="close" size={16} /></button></div>}
      {notice && <div className="banner notice-banner" role="status"><span><Icon name="check" size={15} />{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="close" size={16} /></button></div>}
      {stage && !setupOpen && <div className={`stage-banner ${stage.resumable && !busy ? 'stage-paused' : ''}`} role="status"><div><span className={`stage-marker ${busy ? 'stage-active' : ''}`} /><strong>{stage.message || stage.stage.replace(/[_-]/g, ' ')}</strong>{stage.total !== undefined && stage.total > 0 && <span className="stage-count">{stage.completed ?? 0} / {stage.total}</span>}</div>{stage.total !== undefined && stage.total > 0 && <progress value={stage.completed ?? 0} max={stage.total} aria-label={`${stage.stage} progress`} />}{stage.resumable && !busy && sessionId && <button className="secondary-button" disabled={locked || !ready} onClick={() => void resumeTask()}><Icon name="arrow" size={13} />Resume task</button>}</div>}

      <div className={`conversation ${messages.length ? 'has-messages' : ''}`} aria-label="Conversation" aria-busy={busy || loadingSession}>
        {loadingSession ? <div className="loading-state"><span className="spinner" />Opening your chat…</div> : !messages.length ? <div className="welcome">
          <div className="welcome-symbol"><Icon name="brand" size={32} /><span className="welcome-orbit" /></div>
          <p className="eyebrow">YOUR AI. YOUR FREEDOM.</p>
          <h1>Your ideas. Your own AI.</h1>
          <p className="welcome-description">{chosenMode.description}<br /><span>A local model, running on your computer.</span></p>
          <div className="suggestions">{chosenMode.examples.map((example, index) => <button key={example} disabled={locked} onClick={() => { setDraft(example); inputRef.current?.focus(); }}><span className="suggestion-number">0{index + 1}</span><span>{example}</span><Icon name="chevron" size={15} /></button>)}</div>
          {!ready && <button className="setup-prompt" onClick={() => setSetupOpen(true)}><span className="status-dot" />Set up your local model<Icon name="chevron" size={13} /></button>}
        </div> : <div className="message-list">
          {messages.map((message, index) => <article className={`message ${message.role}`} key={index}><div className="message-avatar">{message.role === 'assistant' ? <Icon name="brand" size={17} /> : 'Y'}</div><div className="message-body"><div className="message-label">{message.role === 'assistant' ? 'Free Local Agent' : 'You'}{message.role === 'assistant' && <span>{selectedModelName}</span>}</div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}<Icon name="external" size={11} /></a>, img: ({ alt }) => <span className="muted">[Image: {alt || 'image'}]</span> }}>{message.content}</ReactMarkdown></div></div></article>)}
          {tools.length > 0 && <div className="tool-activity" aria-label="Tool activity">{tools.map((tool) => <details key={tool.id}><summary><span className={`tool-dot ${tool.status === 'completed' || tool.status === 'success' ? 'complete' : tool.status === 'failed' || tool.status === 'error' ? 'failed' : ''}`} /><span>{tool.title}</span><span className="tool-status">{tool.status}</span></summary>{tool.input !== undefined && <pre>{displayValue(tool.input)}</pre>}{tool.output !== undefined && <pre>{displayValue(tool.output)}</pre>}</details>)}</div>}
          {busy && <div className="working-status" role="status"><span className="working-dots"><i /><i /><i /></span>{permissions.length ? 'Waiting for your approval' : thinking ? 'Thinking locally…' : 'Working…'}</div>}
        </div>}
        <div ref={endRef} />
      </div>

      <div className="composer-area"><form className={`composer ${busy ? 'working' : ''}`} onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        {files.length > 0 && <div className="attachment-list">{files.map((file) => <span className="attachment" key={file.path} title={file.path}><Icon name="attach" size={13} />{file.name}<button type="button" className="icon-button" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setFiles((current) => current.filter((item) => item.path !== file.path))}><Icon name="close" size={12} /></button></span>)}</div>}
        <label className="sr-only" htmlFor="message-input">Message Free Local Agent</label><textarea ref={inputRef} id="message-input" value={draft} disabled={busy || loadingSession} placeholder={ready ? (mode === 'coding' ? 'Ask about your project, or describe what to build…' : 'Ask anything, or add a file to work with…') : 'Set up a local model to start a conversation…'} rows={2} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} />
        <div className="composer-toolbar"><div className="composer-left"><button className="icon-button" type="button" disabled={locked || !bridge || !status?.utilities.fileReading} title={status?.utilities.fileReading ? 'Attach local files' : 'Enable Read files in Tools to attach documents'} aria-label="Attach local files" onClick={() => void action(async () => { const selected = await bridge!.selectFiles(); setFiles((current) => [...current, ...selected.filter((file) => !current.some((existing) => existing.path === file.path))]); })}><Icon name="attach" size={19} /></button><span className="toolbar-divider" /><label className="model-select"><span className="sr-only">Local model</span><select value={selectedModel?.id ?? ''} disabled={locked || !status?.runtime.ready || !bridge} onChange={(event) => void settingsAction(() => bridge!.selectModel(event.target.value))}><option value="" disabled>Choose a model</option>{status?.models.filter((model) => model.installed).map((model) => <option key={model.id} value={model.id} disabled={!!model.blockedReason || model.fit === 'insufficient' || (model.fit === 'slow' && !status?.slowMode)}>{model.name}</option>)}</select></label></div>{busy ? <button type="button" className="stop-button" aria-label="Stop response" onClick={() => void action(async () => { if (sessionRef.current) await bridge!.cancel(sessionRef.current); })}><Icon name="stop" size={14} />Stop</button> : <button className="send-button" type="submit" aria-label="Send message" disabled={!draft.trim() || !ready || locked}><Icon name="arrow" size={20} /></button>}</div>
      </form><p className="composer-note"><span>Inference stays on this computer.</span>{selectedModel?.toolCapable === false ? 'Chat model · agent tools unavailable.' : mode === 'research' ? webActive ? 'Web research uses the internet.' : 'Web research is off.' : 'Review important answers.'}<span className="enter-note">↵ to send · ⇧↵ new line</span></p></div>
    </main>

    {setupOpen && <ModelSetup status={status} mode={mode} ready={ready} busy={locked} setupBusy={setupBusy} calibrating={calibrating} importing={importing} download={download} stage={stage} error={error} hasBridge={!!bridge} dialogRef={setupRef} onKeyDown={(event) => { if (event.key === 'Escape' && ready && !locked && !setupBusy) setSetupOpen(false); trapDialogFocus(event, setupRef.current); }} onClose={() => { setSetupOpen(false); setError(null); inputRef.current?.focus(); }} onSetup={checkRuntime} onImport={importModel} onCalibrate={calibrateModel} onSelect={(id) => settingsAction(() => bridge!.selectModel(id))} onDownload={downloadModel} onCancelDownload={cancelDownload} onUtilities={setUtilities} onSlowMode={(enabled) => settingsAction(() => bridge!.setSlowMode(enabled))} />}
    {permissions[0] && <PermissionDialog key={permissions[0].requestId} request={permissions[0]} onRespond={respondPermission} />}
  </div>;
}
