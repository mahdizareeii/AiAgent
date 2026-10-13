import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Icon from './Icons';
import ModelSetup, { activeModelDownload, ModelDownloadStatus } from './ModelSetup';
import Utilities from './Utilities';
import Plugins from './Plugins';
import WorkingDetails from './WorkingDetails';
import TaskOutcomeDetails from './TaskOutcomeDetails';
import CreateFolderDialog from './CreateFolderDialog';
import PreferenceChoice from './PreferenceChoice';
import { appendThinking } from '../thinking';
import { emptyToolHistory, updateToolHistory } from '../tool-history';
import { createStatusLoader, modelIsUsable, modelSetupMessage, runtimePresentation, shouldOpenModelSetup } from './status-flow';
import { canPrepareTools, modelEvidence } from './model-controls';
import { composerPlaceholder, conversationStage, isNearConversationEnd, shouldFollowConversation, workingDetailsIndexes } from './conversation-flow';
import { newSessionOptions, resolveTaskSession } from './task-flow';
import { showOutcome } from './task-evidence';
import { normalizeTextScale, readTextScale, TEXT_SCALE_KEY } from './appearance';
import { applyApprovalRequest, applyApprovalResolution, applyApprovalSnapshot, emptyApprovals } from './approval-flow';
import { prepareValidationTask } from './validation-flow';
import type { AgentEvent, AgentStatus, Attachment, ChatMessage, DownloadProgress, MemoryMode, Mode, PermissionRequest, StageProgress, TaskEffort, UtilityPreferences } from './types';

const modes: { id: Mode; name: string; icon: 'code' | 'search' | 'spark'; description: string; examples: string[] }[] = [
  { id: 'coding', name: 'Task', icon: 'code', description: 'Describe the result. Your agent plans, builds, and checks its work.', examples: ['Build a new project in this workspace', 'Build a simple website from my idea', 'Explore this project and fix a bug'] },
  { id: 'research', name: 'Read-only research', icon: 'search', description: 'Explore questions with sources you can review.', examples: ['Research a topic and compare reliable sources', 'Summarize a document I attach', 'Compare approaches and explain the tradeoffs'] },
  { id: 'assistant', name: 'Chat', icon: 'spark', description: 'Write, plan, and work through ideas.', examples: ['Help me work through an idea', 'Turn these notes into a clear plan', 'Explain something step by step'] },
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

export function modelReadyForConversation(status: AgentStatus | null, download: DownloadProgress | null) {
  return modelIsUsable(status) && (!download || download.modelId !== status?.selectedModel);
}

interface DisplayError { message: string | null; revision: number; trialId?: string; }
type ErrorUpdate = string | null | ((current: string | null) => string | null);
export function nextDisplayError(current: DisplayError, update: ErrorUpdate, revision: number): DisplayError {
  return { message: typeof update === 'function' ? update(current.message) : update, revision };
}
export function bindDisplayErrorToTrial(current: DisplayError, revision: number, trialId: string): DisplayError {
  return current.revision === revision ? { ...current, trialId } : current;
}
export function newFailedTrialId(status: AgentStatus | undefined, modelId: string, previousTrialId: string | undefined) {
  const trial = status?.experimentalTrial;
  return trial?.state === 'failed' && trial.modelId === modelId && trial.id && trial.id !== previousTrialId ? trial.id : undefined;
}

function trapDialogFocus(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== 'Tab') return;
  const focusable = [...(container?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? [])];
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
  const [displayError, setDisplayError] = useState<DisplayError>({ message: null, revision: 0 });
  const errorRevisionRef = useRef(0);
  const error = displayError.message;
  const setError = useCallback((update: ErrorUpdate) => {
    const revision = ++errorRevisionRef.current;
    setDisplayError(current => nextDisplayError(current, update, revision));
    return revision;
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [calibrating, setCalibrating] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [view, setView] = useState<'workspace' | 'plugins'>('workspace');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('free-local-agent-theme') === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  });
  const [textScale, setTextScale] = useState(() => { try { return readTextScale(localStorage); } catch { return 100; } });
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const [cancellingDownload, setCancellingDownload] = useState(false);
  const [stage, setStage] = useState<StageProgress | null>(null);
  const [mode, setMode] = useState<Mode>('coding');
  const [taskEffort, setTaskEffort] = useState<TaskEffort>('careful');
  const [modelTrial, setModelTrial] = useState<string | null>(null);
  const [validating, setValidating] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | undefined>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [selectingProject, setSelectingProject] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolHistory, setToolHistory] = useState(emptyToolHistory);
  const { tools, truncated: toolsTruncated } = toolHistory;
  const [approvalView, setApprovalView] = useState(emptyApprovals);
  const permissions = approvalView.pending;
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [expandedWorking, setExpandedWorking] = useState(new Set<number>());
  const statusLoaderRef = useRef(createStatusLoader<AgentStatus>());
  const approvalLoaderRef = useRef(createStatusLoader<Awaited<ReturnType<NonNullable<typeof bridge>['approvals']>>>());
  const initializedStatusRef = useRef(false);
  const reviewModelAfterFailureRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const loadingSessionRef = useRef(false);
  const selectingProjectRef = useRef(false);
  const reconnectedSessionRef = useRef<string | null>(null);
  const validationPreparingRef = useRef(false);
  const downloadCancelRef = useRef(false);
  const downloadPendingRef = useRef(false);
  const settingsBusyRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followingOutputRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const setupRef = useRef<HTMLDivElement>(null);
  const utilitiesRef = useRef<HTMLDivElement>(null);
  const pluginHeadingRef = useRef<HTMLHeadingElement>(null);
  const chosenMode = modes.find((item) => item.id === mode) ?? modes[0];
  const selectedModel = status?.models.find((model) => model.id === status.selectedModel);
  const activeDownload = activeModelDownload(download, status);
  const trialPreparing = !!modelTrial || ['loading', 'calibrating'].includes(status?.experimentalTrial?.state ?? '');
  const ready = modelReadyForConversation(status, activeDownload);
  const calibrated = !!status && !!selectedModel && modelEvidence(status, selectedModel).some(item => item.label === 'Tool format' && item.status === 'passed');
  const researchMode = mode === 'coding' || mode === 'research';
  const researchEnabled = status?.plugins.taskResearch === true;
  const engine = runtimePresentation(status, setupBusy);
  const visibleWorking = workingDetailsIndexes(messages, busy, tools.length > 0);
  const visibleStage = conversationStage(stage);

  const refresh = useCallback(async (fetchStatus?: () => Promise<AgentStatus>) => {
    if (!bridge) throw new Error('The desktop connection is unavailable. Launch Free Local Agent as a desktop app to connect to its local runtime.');
    return statusLoaderRef.current.load(fetchStatus ?? (() => bridge.status()), (next) => {
      setStatus(next);
      if (next.downloadingModel !== undefined && !downloadPendingRef.current) {
        setDownload(current => current?.modelId === next.downloadingModel ? current : null);
        if (!next.downloadingModel) setCancellingDownload(false);
      }
      if (reviewModelAfterFailureRef.current) {
        reviewModelAfterFailureRef.current = false;
        if (!modelIsUsable(next)) setSetupOpen(true);
      }
      if (!initializedStatusRef.current) {
        initializedStatusRef.current = true;
        setMode('coding');
        setTaskEffort('careful');
        setProjectPath(next.projectPath);
        if (shouldOpenModelSetup(next)) setSetupOpen(true);
      }
    });
  }, [bridge]);

  const reconcileApprovals = useCallback(async (id = sessionRef.current) => {
    if (!bridge || !id) return;
    await approvalLoaderRef.current.load(() => bridge.approvals(id), snapshot => {
      if (sessionRef.current === id) setApprovalView(current => applyApprovalSnapshot(current, snapshot));
    });
  }, [bridge]);

  useEffect(() => {
    let live = true;
    refresh().catch((reason) => { if (live) { setError(errorMessage(reason)); setSetupOpen(true); } });

    const unsubscribe = bridge?.onEvent((event: AgentEvent) => {
      if (event.type === 'status') { void refresh().catch((reason) => setError(errorMessage(reason))); return; }
      if (event.type === 'download') { setDownload(event); return; }
      if (event.sessionId && event.sessionId !== sessionRef.current) return;
      if (event.type === 'stage') { setStage(event); return; }
      if (event.type === 'message') {
        if (event.thinking) {
          setThinking(true);
          setMessages(current => {
            const last = current.at(-1);
            return last?.role === 'assistant'
              ? [...current.slice(0, -1), { ...last, thinking: appendThinking(last.thinking ?? '', event.text) }]
              : [...current, { role: 'assistant', content: '', thinking: appendThinking('', event.text) }];
          });
          return;
        }
        setThinking(false);
        setMessages((current) => {
          const last = current.at(-1);
          return last?.role === 'assistant' ? [...current.slice(0, -1), { ...last, content: last.content + event.text }] : [...current, { role: 'assistant', content: event.text }];
        });
      } else if (event.type === 'tool') {
        setThinking(false);
        setToolHistory((current) => updateToolHistory(current, event));
      } else if (event.type === 'permission') {
        setApprovalView(current => applyApprovalRequest(current, event.sessionId, event));
        if (event.revision === undefined || !event.turnId) void reconcileApprovals().catch(() => {});
      } else if (event.type === 'permission_resolved') {
        setApprovalView(current => applyApprovalResolution(current, event));
      } else if (event.type === 'permission_cancelled') {
        void reconcileApprovals().catch(() => {});
      } else if (event.type === 'done') {
        setThinking(false);
        void reconcileApprovals().catch(() => {});
        setStage((current) => current?.resumable ? current : null);
        void refresh().catch((reason) => setError(errorMessage(reason)));
      } else if (event.type === 'error') {
        setError(event.text ?? event.error ?? 'Something went wrong. Please try again.');
        if (event.sessionId) {
          setThinking(false);
          void reconcileApprovals().catch(() => {});
          setStage((current) => current?.resumable ? current : null);
        }
      }
    });
    return () => { live = false; statusLoaderRef.current.invalidate(); approvalLoaderRef.current.invalidate(); unsubscribe?.(); };
  }, [bridge, refresh, reconcileApprovals]);

  useEffect(() => {
    const reconcile = () => { void reconcileApprovals().catch(() => {}); };
    reconcile();
    const onFocus = () => { reconcile(); void refresh().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    const interval = permissions.length ? window.setInterval(reconcile, 5000) : undefined;
    return () => { window.removeEventListener('focus', onFocus); if (interval !== undefined) window.clearInterval(interval); };
  }, [sessionId, permissions.length, reconcileApprovals, refresh]);

  useEffect(() => {
    const id = status?.activeSessionId;
    if (!bridge || !id || busyRef.current) return;
    // Restoring a renderer only reads the host's running task. It never sends,
    // resumes, or approves that task again.
    busyRef.current = true; setBusy(true); setLoadingSession(true);
    reconnectedSessionRef.current = id; sessionRef.current = id; setSessionId(id);
    approvalLoaderRef.current.invalidate(); setApprovalView(emptyApprovals(id));
    setView('workspace');
    void (async () => {
      try {
        const loaded = await bridge.loadSession(id);
        if (sessionRef.current !== id || reconnectedSessionRef.current !== id) return;
        setMessages(loaded.messages); setMode(loaded.mode); setTaskEffort(loaded.taskEffort ?? 'standard');
        setProjectPath(loaded.projectPath); setStage(loaded.stage ?? null); setToolHistory(emptyToolHistory());
        await reconcileApprovals(id);
      } catch (reason) { setError(errorMessage(reason)); }
      finally { setLoadingSession(false); }
    })();
  }, [status?.activeSessionId, bridge, reconcileApprovals]);

  useEffect(() => {
    const id = reconnectedSessionRef.current;
    if (!status || !id || status.activeSessionId) return;
    reconnectedSessionRef.current = null;
    void (async () => {
      await synchronizeSession(id).catch(reason => setError(errorMessage(reason)));
      await reconcileApprovals(id).catch(() => {});
      setBusy(false); busyRef.current = false; setThinking(false);
    })();
  }, [status, reconcileApprovals]);

  useEffect(() => {
    if (!busy) return;
    const interval = window.setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => window.clearInterval(interval);
  }, [busy, refresh]);

  useEffect(() => {
    const expandedCount = [...expandedWorking].filter((index) => visibleWorking.has(index)).length;
    if (shouldFollowConversation(followingOutputRef.current, expandedCount)) endRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages, busy, tools, expandedWorking]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('free-local-agent-theme', theme); } catch { /* An unavailable preference store does not prevent using the workspace. */ }
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String(textScale / 100));
    try { localStorage.setItem(TEXT_SCALE_KEY, String(textScale)); } catch { /* Text remains readable when preference storage is unavailable. */ }
  }, [textScale]);
  useEffect(() => {
    if (!setupOpen) return;
    setupRef.current?.querySelector<HTMLElement>('button:not(:disabled), summary')?.focus();
  }, [setupOpen]);
  useEffect(() => {
    if (view === 'plugins') pluginHeadingRef.current?.focus();
    else if (!setupOpen && !utilitiesOpen && !createFolderOpen) inputRef.current?.focus();
  }, [view, setupOpen, utilitiesOpen, createFolderOpen]);
  useEffect(() => {
    if (utilitiesOpen) utilitiesRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
  }, [utilitiesOpen]);
  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = 'auto';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 180)}px`;
  }, [draft]);

  async function action(operation: () => Promise<unknown>) {
    setError(null);
    try { await operation(); } catch (reason) { setError(errorMessage(reason)); }
  }

  function newChat(nextMode: Mode = 'coding') {
    if (busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current) return;
    setSessionId(null); sessionRef.current = null;
    approvalLoaderRef.current.invalidate(); setApprovalView(emptyApprovals()); setTaskEffort('careful');
    followingOutputRef.current = true; setExpandedWorking(new Set());
    if (nextMode !== 'assistant') setProjectPath(status?.projectPath ?? projectPath);
    setView('workspace'); setMode(nextMode); setMessages([]); setToolHistory(emptyToolHistory()); setFiles([]); setDraft(''); setError(null); setNotice(null); setStage(null);
    inputRef.current?.focus();
  }

  async function loadSession(id: string) {
    if (!bridge || busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current) return;
    loadingSessionRef.current = true;
    setLoadingSession(true); setError(null);
    try {
      const loaded = await bridge.loadSession(id);
      followingOutputRef.current = true; setExpandedWorking(new Set());
      setSessionId(loaded.id); sessionRef.current = loaded.id;
      approvalLoaderRef.current.invalidate(); setApprovalView(emptyApprovals(loaded.id)); setTaskEffort(loaded.taskEffort ?? 'standard');
      setView('workspace');
      setMessages(loaded.messages); setMode(loaded.mode); setProjectPath(loaded.projectPath); setToolHistory(emptyToolHistory()); setFiles([]); setDraft(''); setStage(loaded.stage ?? null);
      await reconcileApprovals(loaded.id);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { loadingSessionRef.current = false; setLoadingSession(false); }
  }

  async function synchronizeSession(id: string) {
    if (!bridge || sessionRef.current !== id) return;
    const loaded = await bridge.loadSession(id);
    if (sessionRef.current !== id) return;
    setMessages(loaded.messages);
    setStage(loaded.stage?.resumable ? loaded.stage : null);
    return loaded;
  }

  async function chooseProject() {
    if (!bridge || busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current || sessionRef.current) return null;
    selectingProjectRef.current = true; setSelectingProject(true); setError(null);
    try {
      const selected = await bridge.selectProject();
      if (selected) { setProjectPath(selected); setNotice(null); }
      return selected;
    } finally { selectingProjectRef.current = false; setSelectingProject(false); }
  }

  function openCreateFolder() {
    if (!bridge || busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current || sessionRef.current) return;
    setFolderError(null); setCreateFolderOpen(true);
  }

  async function createFolder(name: string) {
    if (!bridge || busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current || sessionRef.current) return;
    selectingProjectRef.current = true; setSelectingProject(true); setFolderError(null);
    try {
      const created = await bridge.createProject({ name });
      if (created) { setProjectPath(created); setNotice(`Created workspace ${folderName(created)}.`); setCreateFolderOpen(false); await refresh(); }
    } catch (reason) { setFolderError(errorMessage(reason)); }
    finally { selectingProjectRef.current = false; setSelectingProject(false); }
  }

  async function sendMessage() {
    const text = draft.trim();
    const submittedFiles = files;
    const userCountBeforeSend = messages.filter((message) => message.role === 'user').length;
    if (!bridge || !text || createFolderOpen || permissions.length > 0 || busyRef.current || loadingSessionRef.current || selectingProjectRef.current || calibrating || trialPreparing || validating || importing || settingsBusyRef.current || setupBusy) return;
    if (!ready) { setSetupOpen(true); return; }
    if (mode === 'coding' && !canPrepareTools(selectedModel)) { setError('This model has no validated task tools. Choose another model, retry its tool check under Advanced, or start New chat.'); return; }
    if (files.length && !status?.utilities.fileReading) { setError('Enable Read files in Tools to use your attached files.'); return; }
    let taskProjectPath = projectPath;
    if (mode === 'coding' && !taskProjectPath) {
      if (sessionRef.current) { setError('This task has no workspace. Start a new task and choose a folder.'); return; }
      try {
        const selected = await chooseProject();
        if (!selected) { setNotice('Choose a workspace when you’re ready. Your task is still here.'); return; }
        taskProjectPath = selected;
      } catch (reason) { setError(errorMessage(reason)); return; }
    }
    followingOutputRef.current = true;
    stopRequestedRef.current = false;
    setError(null); setNotice(null); setBusy(true); busyRef.current = true; setThinking(false); setToolHistory(emptyToolHistory()); setStage({ stage: 'preparing', message: 'Preparing your local task' });
    let started = false;
    let failed = false;
    try {
      const currentId = await resolveTaskSession(sessionRef.current,
        () => bridge.createSession(newSessionOptions(mode, taskProjectPath, taskEffort)),
        (id) => { sessionRef.current = id; setSessionId(id); approvalLoaderRef.current.invalidate(); setApprovalView(emptyApprovals(id)); }, () => stopRequestedRef.current);
      setMessages((current) => [...current, { role: 'user', content: text + (files.length ? `\n\nAttached: ${files.map((file) => file.name).join(', ')}` : '') }, { role: 'assistant', content: '' }]);
      setDraft(''); setFiles([]); started = true;
      await bridge.send({ sessionId: currentId, text, ...(files.length ? { files } : {}) });
      await refresh();
    } catch (reason) {
      failed = true; setError(errorMessage(reason)); if (started) setDraft(text);
      reviewModelAfterFailureRef.current = true;
      await refresh().catch(() => { /* Keep the original task error if status is temporarily unavailable. */ });
    }
    finally {
      setStage((current) => current?.resumable ? current : null);
      if (sessionRef.current) {
        const saved = await synchronizeSession(sessionRef.current).catch((reason) => { setError((current) => current ?? errorMessage(reason)); return undefined; });
        // Only a verified rejection before the host recorded the request restores
        // attachments. A failed task that already ran must not stage them again.
        if (failed && started && saved && saved.messages.filter((message) => message.role === 'user').length === userCountBeforeSend) setFiles(submittedFiles);
      }
      await reconcileApprovals().catch(() => {});
      setBusy(false); busyRef.current = false; setThinking(false); inputRef.current?.focus();
    }
  }

  async function checkRuntime() {
    if (!bridge || activeDownload || downloadPendingRef.current) return;
    setSetupBusy(true); setError(null);
    try {
      const next = await refresh(() => bridge.setup({}));
      if (next?.runtime.state === 'error' || next?.runtime.error) setError(next.runtime.error ?? 'The bundled runtime could not start. Please retry.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSetupBusy(false); }
  }

  async function downloadModel(id: string) {
    if (!bridge || activeDownload || downloadPendingRef.current || busyRef.current || loadingSessionRef.current || settingsBusyRef.current || calibrating || trialPreparing || validating || importing || setupBusy) return;
    downloadPendingRef.current = true;
    downloadCancelRef.current = false;
    setCancellingDownload(false);
    setError(null); setDownload({ modelId: id, progress: { status: 'Starting download' } });
    try { await bridge.downloadModel(id); await refresh(); }
    catch (reason) {
      const message = errorMessage(reason);
      if (downloadCancelRef.current && /cancelled|canceled|aborted/i.test(message)) setNotice('Download canceled. You can retry it when you’re ready.');
      else setError(message);
    }
    finally { downloadPendingRef.current = false; setDownload(null); setCancellingDownload(false); await refresh().catch(() => {}); }
  }

  async function cancelDownload() {
    if (!bridge || cancellingDownload || !activeDownload) return;
    downloadCancelRef.current = true;
    setCancellingDownload(true);
    try { await bridge.cancelDownload(); }
    catch (reason) { setError(errorMessage(reason)); setCancellingDownload(false); }
  }

  async function importModel() {
    if (!bridge || activeDownload || downloadPendingRef.current) return;
    const before = new Map(status?.models.map(model => [model.id, { installed: model.installed, error: model.verificationError }]) ?? []);
    setImporting(true); setError(null);
    try {
      await bridge.importModel();
      const next = await refresh();
      const added = next?.models.find(model => model.installed && (!before.get(model.id)?.installed || before.get(model.id)?.error && !model.verificationError));
      if (added) setNotice(`${added.name} was added to the model library.`);
    }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setImporting(false); }
  }

  async function calibrateModel(id: string) {
    if (!bridge || activeDownload || downloadPendingRef.current) return;
    setCalibrating(id); setError(null);
    try {
      await bridge.calibrateModel(id);
      const next = await refresh();
      const model = next?.models.find((item) => item.id === id);
      setNotice(model?.measuredTokensPerSecond !== undefined ? `Calibration: ${model.measuredTokensPerSecond.toFixed(1)} tokens/sec on this computer.` : 'Calibration finished.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setCalibrating(null); }
  }

  async function tryModel(id: string) {
    if (!bridge || busyRef.current || settingsBusyRef.current || activeDownload || downloadPendingRef.current) return;
    const previousTrialId = status?.experimentalTrial?.id;
    setModelTrial(id); setError(null);
    const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 1000);
    try {
      if (bridge.startModelTrial) await bridge.startModelTrial(id, 'ssd-experts');
      else throw new Error('SSD expert streaming requires the updated desktop runtime.');
      await refresh();
    }
    catch (reason) {
      window.clearInterval(timer);
      const revision = setError(errorMessage(reason));
      const next = await refresh().catch(() => undefined);
      const trialId = newFailedTrialId(next, id, previousTrialId);
      if (trialId && errorRevisionRef.current === revision) setDisplayError(current => bindDisplayErrorToTrial(current, revision, trialId));
    }
    finally { window.clearInterval(timer); setModelTrial(null); }
  }

  async function cancelTrial(trialId: string) {
    if (!bridge || !trialId) return;
    await action(async () => { await bridge.cancelModelTrial(trialId); await refresh(); });
  }

  async function validateModel(id: string) {
    if (!bridge || busyRef.current || loadingSessionRef.current || settingsBusyRef.current || activeDownload || downloadPendingRef.current) return;
    setValidating(id); setError(null); setSetupOpen(false); setBusy(true); busyRef.current = true;
    validationPreparingRef.current = true;
    followingOutputRef.current = true; stopRequestedRef.current = false;
    setToolHistory(emptyToolHistory()); setExpandedWorking(new Set());
    try {
      const prepared = await prepareValidationTask(() => bridge.createModelValidationTask(id), taskId => {
        validationPreparingRef.current = false;
        sessionRef.current = taskId; setSessionId(taskId);
        approvalLoaderRef.current.invalidate(); setApprovalView(emptyApprovals(taskId));
      }, taskId => bridge.loadSession(taskId), () => stopRequestedRef.current);
      const loaded = prepared.session;
      setMode(loaded.mode); setTaskEffort(loaded.taskEffort ?? 'careful'); setProjectPath(loaded.projectPath);
      setFiles([]); setDraft(''); setView('workspace');
      setMessages([...loaded.messages, { role: 'user', content: prepared.prompt }, { role: 'assistant', content: '' }]);
      await bridge.send({ sessionId: loaded.id, text: prepared.prompt });
    } catch (reason) { setError(errorMessage(reason)); }
    finally {
      validationPreparingRef.current = false;
      if (sessionRef.current) await synchronizeSession(sessionRef.current).catch(() => {});
      await reconcileApprovals().catch(() => {}); await refresh().catch(() => {});
      setBusy(false); busyRef.current = false; setThinking(false); setValidating(null);
    }
  }

  async function setMemoryMode(memoryMode: MemoryMode) {
    if (bridge && !activeDownload && !downloadPendingRef.current) await settingsAction(() => bridge.setExecutionPreferences({ memoryMode }));
  }

  async function selectModel(id: string) {
    if (!bridge || activeDownload || downloadPendingRef.current) return;
    await settingsAction(async () => {
      const model = status?.models.find(item => item.id === id);
      if (model?.fit === 'slow' && !status?.slowMode && (status?.memoryMode ?? 'automatic') === 'automatic') await bridge.setSlowMode(true);
      await bridge.selectModel(id);
    });
  }

  async function settingsAction(operation: () => Promise<void>) {
    if (busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current) return;
    settingsBusyRef.current = true; setSettingsBusy(true); setError(null);
    try { await operation(); await refresh(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { settingsBusyRef.current = false; setSettingsBusy(false); }
  }

  async function setUtilities(preferences: UtilityPreferences) {
    if (bridge) await settingsAction(() => bridge.setUtilities(preferences));
  }

  async function setResearchPlugin(enabled: boolean) {
    if (bridge) await settingsAction(() => bridge.setPlugins({ taskResearch: enabled }));
  }

  async function resumeTask() {
    const id = sessionRef.current;
    if (!id || !bridge || !ready || createFolderOpen || busyRef.current || loadingSessionRef.current || selectingProjectRef.current || settingsBusyRef.current || calibrating || trialPreparing || validating || importing || setupBusy) return;
    stopRequestedRef.current = false;
    setError(null); setBusy(true); busyRef.current = true; setThinking(false); setToolHistory(emptyToolHistory());
    // A resumed turn gets its own stable Working row; never stream over the
    // interrupted reply's saved thinking or tool history.
    setMessages(current => [...current, { role: 'assistant', content: '' }]);
    setStage({ stage: 'resuming', message: 'Resuming from the saved checkpoint' });
    try {
      await bridge.resume(id);
      await refresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally {
      setStage((current) => current?.resumable ? current : null);
      await synchronizeSession(id).catch((reason) => setError((current) => current ?? errorMessage(reason)));
      await reconcileApprovals(id).catch(() => {});
      setBusy(false); busyRef.current = false; setThinking(false);
    }
  }

  async function respondPermission(approved: boolean) {
    const request = permissions[0];
    if (!bridge || !request) return;
    try {
      await bridge.respondPermission({ requestId: request.requestId, approved, sessionId: sessionRef.current ?? undefined, turnId: request.turnId });
    } catch (reason) {
      await reconcileApprovals().catch(() => {});
      throw reason;
    }
    // A settled IPC response cannot authorize the action again. Keep this
    // dialog disabled until an event or snapshot confirms its disappearance.
    await reconcileApprovals().catch(() => setNotice('Your response was recorded. Waiting to refresh approvals from the local host.'));
  }

  async function stopTask() {
    stopRequestedRef.current = true;
    // Model validation preparation has no bound task yet; cancel that host
    // preflight rather than accidentally targeting the previously open chat.
    await bridge?.cancel(validationPreparingRef.current ? undefined : sessionRef.current ?? undefined);
  }

  const locked = busy || loadingSession || selectingProject || permissions.length > 0 || !!calibrating || trialPreparing || !!validating || importing || settingsBusy || setupBusy || createFolderOpen;

  function workingExpanded(index: number, expanded: boolean) {
    setExpandedWorking((current) => {
      if (current.has(index) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(index); else next.delete(index);
      return next;
    });
  }

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Task navigation">
      <div className="brand"><Icon name="brand" size={20} /><span>Free Local Agent</span></div>
      <button className="new-chat" disabled={locked} onClick={() => newChat()}><Icon name="plus" size={17} />New task</button>
      <button className="sidebar-link new-ordinary-chat" disabled={locked} onClick={() => newChat('assistant')}><Icon name="chat" size={17} />New chat</button>
      <button className={`sidebar-link plugins-link ${view === 'plugins' ? 'selected' : ''}`} aria-label="Plugins" aria-current={view === 'plugins' ? 'page' : undefined} onClick={() => setView('plugins')}><Icon name="plugin" size={17} />Plugins{researchEnabled && <span className="nav-count" aria-hidden="true" title="One plugin enabled">1</span>}</button>
      {mode !== 'assistant' && <section className="workspace-section" aria-label="Workspace folder">
        <div className="workspace-heading">Workspace</div>
        <div className="workspace-control" title={projectPath || 'Choose or create a workspace folder'}><Icon name="folder" size={14} /><PreferenceChoice label="Workspace folder" value="" placeholder={selectingProject ? 'Choosing…' : projectPath ? folderName(projectPath) : 'Choose folder'} options={[{ value: 'choose', label: 'Choose folder', description: 'Work in an existing local folder' }, { value: 'create', label: 'Create folder', description: 'Create a new folder for this task' }]} disabled={locked || !bridge || !!sessionId} title={sessionId ? 'Start a new task to change its workspace' : projectPath || 'Choose or create a workspace'} onChange={value => value === 'create' ? openCreateFolder() : void action(chooseProject)} minimumWidth={230} /></div>
      </section>}
      <div className="sidebar-heading">Tasks</div>
      <nav className="session-list" aria-label="Saved tasks">
        {!status?.sessions.length && <p className="empty-history">Your tasks will appear here.</p>}
        {status?.sessions.map((session) => <button key={session.id} className={`session-item ${view === 'workspace' && sessionId === session.id ? 'selected' : ''}`} disabled={locked} onClick={() => void loadSession(session.id)} title={session.title}><Icon name={session.mode === 'coding' ? 'code' : 'chat'} size={15} /><span>{session.title || 'Untitled task'}</span>{session.resumable && <small className="session-paused">Paused</small>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="text-scale-control"><span>Text size</span><PreferenceChoice label="Text size" value={String(textScale)} options={[90, 95, 100, 105, 110, 115, 120, 125].map(value => ({ value: String(value), label: `${value}%` }))} onChange={value => setTextScale(normalizeTextScale(value))} minimumWidth={100} /></div>
        <div className="sidebar-preferences"><span className="local-badge"><span className={`status-dot ${ready && !selectedModel?.needsPreparation ? 'online' : ''}`} />{ready ? selectedModel?.needsPreparation ? 'Prepares when you send' : 'Local model ready' : engine.phase === 'preparing' ? 'Preparing engine…' : engine.phase === 'error' ? 'Engine needs attention' : 'Choose a model'}</span><button className="icon-button theme-toggle" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}><Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} /></button></div>
      </div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="breadcrumb">{view === 'plugins' ? <><Icon name="plugin" size={15} /><strong>Plugins</strong></> : <><Icon name={mode === 'coding' && projectPath ? 'folder' : chosenMode.icon} size={15} /><strong>{sessionId ? status?.sessions.find((session) => session.id === sessionId)?.title || chosenMode.name : mode === 'assistant' ? 'New chat' : 'New task'}</strong>{projectPath && mode !== 'assistant' && <span className="breadcrumb-project" title={projectPath}>{folderName(projectPath)}</span>}</>}</div>
        <div className="header-actions">{view === 'plugins' ? <>{busy && <button type="button" className="stop-button" onClick={() => void action(stopTask)}><Icon name="stop" size={13} />Stop task</button>}<button className="text-button back-to-task" onClick={() => setView('workspace')}><Icon name="back" size={15} />Back to task</button></> : <button className="text-button undo-button" disabled={locked || !bridge} onClick={() => void action(async () => { const result = await bridge!.undo(); setNotice(result.restored ? `Restored ${result.restored} file${result.restored === 1 ? '' : 's'}.` : 'No file changes to undo.'); })} title="Undo the most recent file change"><Icon name="undo" size={15} />Undo</button>}</div>
      </header>

      {status?.storage?.profile === 'isolated' && <div className="banner profile-banner" role="status"><div><strong>Separate test profile</strong><span>This window uses its own chats and models.</span><code title={status.storage.path}>{status.storage.path}</code></div></div>}

      {activeDownload && !setupOpen && <ModelDownloadStatus download={activeDownload} models={status?.models ?? []} cancelling={cancellingDownload} onCancel={cancelDownload} />}

      {error && !setupOpen && <div className="banner error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><Icon name="close" size={16} /></button></div>}
      {notice && <div className="banner notice-banner" role="status"><span><Icon name="check" size={15} />{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="close" size={16} /></button></div>}
      {visibleStage && !setupOpen && <div className={`stage-banner ${visibleStage.resumable && !busy ? 'stage-paused' : ''}`} role="status"><div><span className={`stage-marker ${busy ? 'stage-active' : ''}`} /><strong>{visibleStage.message || visibleStage.stage.replace(/[_-]/g, ' ')}</strong>{visibleStage.total !== undefined && visibleStage.total > 0 && <span className="stage-count">{visibleStage.completed ?? 0} / {visibleStage.total}</span>}</div>{visibleStage.total !== undefined && visibleStage.total > 0 && <progress value={visibleStage.completed ?? 0} max={visibleStage.total} aria-label={`${visibleStage.stage} progress`} />}{visibleStage.resumable && !busy && sessionId && <button className="secondary-button" disabled={locked || !ready} onClick={() => void resumeTask()}><Icon name="arrow" size={13} />Resume task</button>}</div>}

      {view === 'plugins' ? <section className="plugins-page" aria-labelledby="plugins-title"><div className="page-heading"><h1 id="plugins-title" tabIndex={-1} ref={pluginHeadingRef}>Plugins</h1><span>Bundled</span></div><Plugins status={status} disabled={locked || !bridge} onEnable={setResearchPlugin} onWebResearch={(enabled) => status ? setUtilities({ ...status.utilities, webResearch: enabled }) : Promise.resolve()} /></section> : <>
      <div className={`conversation ${messages.length ? 'has-messages' : ''}`} ref={conversationRef} onScroll={() => { if (conversationRef.current) followingOutputRef.current = isNearConversationEnd(conversationRef.current); }} aria-label="Conversation" aria-busy={busy || loadingSession}>
        {loadingSession ? <div className="loading-state"><span className="spinner" />Opening your task…</div> : !messages.length ? <div className="welcome">
          <h1>{mode === 'coding' ? 'What would you like to build?' : mode === 'research' ? 'What would you like to explore?' : 'What’s on your mind?'}</h1>
          <p className="welcome-description">{chosenMode.description}</p>
          <div className="suggestions">{chosenMode.examples.map((example) => <button key={example} disabled={locked} onClick={() => { setDraft(example); inputRef.current?.focus(); }}><Icon name={chosenMode.icon} size={16} /><span>{example}</span></button>)}</div>
          {!ready && <p className="setup-prompt"><span className="status-dot" />Choose a local model below to begin.</p>}
        </div> : <div className="message-list">
          {messages.map((message, index) => <article className={`message ${message.role}`} key={index}><div className="message-body">
            {message.role === 'assistant' && visibleWorking.has(index) && <WorkingDetails thinking={message.thinking} active={busy && index === messages.length - 1} thinkingActive={thinking} waitingApproval={permissions.length > 0} stage={visibleStage} tools={busy && index === messages.length - 1 ? tools : message.tools ?? (index === messages.length - 1 ? tools : undefined)} toolsTruncated={busy && index === messages.length - 1 ? toolsTruncated : message.toolsTruncated} expanded={expandedWorking.has(index)} onExpandedChange={(expanded) => workingExpanded(index, expanded)} />}
            {message.content && <><div className="message-label">{message.role === 'assistant' ? 'Free Local Agent' : 'You'}</div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}<Icon name="external" size={11} /></a>, img: ({ alt }) => <span className="muted">[Image: {alt || 'image'}]</span> }}>{message.content}</ReactMarkdown></div></>}
            {message.role === 'assistant' && message.outcome && showOutcome(mode, message.outcome) && <TaskOutcomeDetails outcome={message.outcome} context={mode === 'assistant' ? 'response' : 'task'} />}
          </div></article>)}
          {messages.at(-1)?.role !== 'assistant' && visibleWorking.has(messages.length) && <WorkingDetails active={busy} thinkingActive={thinking} waitingApproval={permissions.length > 0} stage={visibleStage} tools={tools} toolsTruncated={toolsTruncated} expanded={expandedWorking.has(messages.length)} onExpandedChange={(expanded) => workingExpanded(messages.length, expanded)} />}
        </div>}
        <div ref={endRef} />
      </div>

      <div className="composer-area">
        {!busy && (!ready || selectedModel?.needsPreparation ? <div className="model-limitation"><Icon name="monitor" size={15} /><span>{modelSetupMessage(status)}</span></div> : !canPrepareTools(selectedModel) ? <div className="model-limitation"><Icon name="monitor" size={15} /><span>{mode === 'coding' ? 'This model is chat only until its tool check passes. Choose another model or retry under Advanced.' : 'Chat-only model. Selected files can still be attached.'}</span></div> : researchMode && selectedModel && !calibrated ? <div className="model-limitation model-calibration"><Icon name="monitor" size={15} /><span>Tool format has not been verified for the current model profile. Preparation checks it before project tools run.</span></div> : null)}
        <form className={`composer ${busy ? 'working' : ''}`} onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
          {files.length > 0 && <div className="attachment-list">{files.map((file) => <span className="attachment" key={file.path} title={file.path}><Icon name="attach" size={13} />{file.name}<button type="button" className="icon-button" aria-label={`Remove ${file.name}`} disabled={locked} onClick={() => setFiles((current) => current.filter((item) => item.path !== file.path))}><Icon name="close" size={12} /></button></span>)}</div>}
          <label className="sr-only" htmlFor="message-input">Message Free Local Agent</label><textarea ref={inputRef} id="message-input" value={draft} disabled={busy || loadingSession} spellCheck={false} autoCorrect="off" autoCapitalize="off" placeholder={composerPlaceholder(mode, ready, busy, loadingSession)} rows={2} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} />
          <div className="composer-toolbar"><div className="composer-left">
            <button className="icon-button" type="button" disabled={locked || !bridge || !status?.utilities.fileReading} title={status?.utilities.fileReading ? 'Attach local files' : 'Enable Read files in Tools to attach documents'} aria-label="Attach local files" onClick={() => void action(async () => { const selected = await bridge!.selectFiles(); setFiles((current) => [...current, ...selected.filter((file) => !current.some((existing) => existing.path === file.path))]); })}><Icon name="plus" size={18} /></button>
            <button className="composer-chip" type="button" disabled={!status} onClick={() => setUtilitiesOpen(true)} aria-haspopup="dialog"><Icon name="settings" size={13} /><span>Tools</span></button>
          </div><div className="composer-right">
            <button className="composer-chip model-library-button" type="button" disabled={locked} aria-label={`Models: ${selectedModel?.name || 'Choose a model'}`} title="Open model library" aria-haspopup="dialog" onClick={() => setSetupOpen(true)}><Icon name="monitor" size={14} /><span>{selectedModel?.name || 'Choose model'}</span><Icon name="chevron" size={12} /></button>
            {busy ? <button type="button" className="stop-button" aria-label="Stop response" onClick={() => void action(stopTask)}><Icon name="stop" size={13} />Stop</button> : <button className="send-button" type="submit" aria-label="Send message" disabled={!draft.trim() || !ready || locked}><Icon name="arrow" size={18} /></button>}
          </div></div>
        </form><p className="composer-note"><span>Local inference</span><span>{mode === 'coding' ? 'Edits and commands need approval.' : mode === 'assistant' ? 'Chat has no project actions.' : 'Read-only research mode.'}</span><span className="enter-note">↵ Send · ⇧↵ New line</span></p>
      </div>
      </>}
    </main>

    {utilitiesOpen && status && <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === 'Escape') setUtilitiesOpen(false); trapDialogFocus(event, utilitiesRef.current); }}><section className="tools-dialog" ref={utilitiesRef} role="dialog" aria-modal="true" aria-labelledby="tools-title"><div className="tools-dialog-header"><h2 id="tools-title">Agent tools</h2><button className="icon-button" aria-label="Close tools" onClick={() => setUtilitiesOpen(false)}><Icon name="close" size={18} /></button></div><p className="muted">Choose what the agent can access. Preferences apply to your next task; changes are unavailable while a task is running.</p>{error && <p className="inline-error" role="alert">{error}</p>}<Utilities preferences={status.utilities} mode={mode} toolCapable={canPrepareTools(selectedModel)} projectSelected={!!projectPath} calibrated={calibrated} disabled={locked || !bridge} onChange={setUtilities} /><button className="text-button tools-plugin-link" onClick={() => { setUtilitiesOpen(false); setView('plugins'); }}><Icon name="plugin" size={15} />Manage optional Research in Plugins<Icon name="chevron" size={13} /></button></section></div>}
    {createFolderOpen && <CreateFolderDialog busy={selectingProject} error={folderError} onCreate={createFolder} onClose={() => { if (!selectingProjectRef.current) setCreateFolderOpen(false); }} onKeyDown={(event, container) => { if (event.key === 'Escape' && !selectingProjectRef.current) setCreateFolderOpen(false); trapDialogFocus(event, container); }} />}
    {setupOpen && <ModelSetup status={status} mode={mode} ready={ready} busy={locked} setupBusy={setupBusy} calibrating={calibrating} trialModel={modelTrial} validating={validating} importing={importing} download={activeDownload} cancellingDownload={cancellingDownload} stage={stage} error={error} errorTrialId={displayError.trialId} hasBridge={!!bridge} taskEffort={taskEffort} taskPreferencesLocked={!!sessionId} onTaskEffort={next => settingsAction(async () => { await bridge!.setExecutionPreferences({ taskEffort: next }); setTaskEffort(next); })} onSsdTaskHours={hours => settingsAction(() => bridge!.setExecutionPreferences({ ssdTaskHours: hours }))} dialogRef={setupRef} onKeyDown={(event) => { if (event.key === 'Escape' && !locked) setSetupOpen(false); trapDialogFocus(event, setupRef.current); }} onClose={() => { setSetupOpen(false); setError(null); }} onSetup={checkRuntime} onImport={importModel} onCalibrate={calibrateModel} onValidate={validateModel} onMemoryMode={setMemoryMode} onTryModel={tryModel} onCancelTrial={cancelTrial} onSelect={selectModel} onDownload={downloadModel} onCancelDownload={cancelDownload} onSlowMode={(enabled) => settingsAction(() => bridge!.setSlowMode(enabled))} />}
    {permissions[0] && <PermissionDialog key={permissions[0].requestId} request={permissions[0]} onRespond={respondPermission} />}
  </div>;
}
