import { useEffect, useState } from 'react';
import Icon from './Icons';
import type { AgentStatus, ApprovalUtility } from './types';

interface Props {
  status: AgentStatus | null;
  disabled: boolean;
  onEnable: (enabled: boolean) => Promise<void>;
  onWebResearch: (enabled: boolean) => Promise<void>;
  onSetApproval: (utility: ApprovalUtility) => Promise<void>;
  onRevokeApproval: (utility?: ApprovalUtility) => Promise<void>;
}

const approvalUtilities: { id: ApprovalUtility; label: string; description: string }[] = [
  { id: 'fileReading', label: 'Read files & PDFs', description: 'Remember read access in this workspace.' },
  { id: 'projectSearch', label: 'Find files & text', description: 'Remember local filename and text searches.' },
  { id: 'fileEditing', label: 'Create & edit files', description: 'Remember file change approvals in this workspace.' },
];

export default function Plugins({ status, disabled, onEnable, onWebResearch, onSetApproval, onRevokeApproval }: Props) {
  const enabled = status?.plugins.taskResearch === true;
  const internetAllowed = status?.utilities.webResearch === true;
  const [notes, setNotes] = useState<Awaited<ReturnType<NonNullable<typeof window.localAgent>['listResearchNotes']>>>([]);
  const [noteQuery, setNoteQuery] = useState('');
  const [notesBusy, setNotesBusy] = useState(false);
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    if (status?.projectPath && window.localAgent) void window.localAgent.listResearchNotes({ workspacePath: status.projectPath }).then(value => { if (live) setNotes(value); }).catch(() => { if (live) setNotes([]); });
    else setNotes([]);
    return () => { live = false; };
  }, [status?.projectPath]);
  async function searchNotes(query = noteQuery) {
    if (!window.localAgent || !status?.projectPath) return;
    setNotesBusy(true); try { setNotes(await window.localAgent.listResearchNotes({ workspacePath: status.projectPath, query })); } finally { setNotesBusy(false); }
  }
  async function deleteNotes() {
    if (!window.localAgent || !status?.projectPath || !selectedNotes.size) return;
    setNotesBusy(true); try { await window.localAgent.deleteResearchNotes({ workspacePath: status.projectPath, ids: [...selectedNotes] }); setSelectedNotes(new Set()); await searchNotes(); } finally { setNotesBusy(false); }
  }
  async function clearNotes() {
    if (!window.localAgent || !status?.projectPath || !notes.length || !window.confirm('Clear the saved Research notebook for this workspace?')) return;
    setNotesBusy(true); try { await window.localAgent.clearResearchNotebook({ workspacePath: status.projectPath }); setSelectedNotes(new Set()); setNotes([]); } finally { setNotesBusy(false); }
  }
  async function exportNotes(format: 'json' | 'markdown') {
    if (!window.localAgent || !status?.projectPath) return;
    const text = await window.localAgent.exportResearchNotebook({ workspacePath: status.projectPath, format });
    const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `research-notebook.${format === 'json' ? 'json' : 'md'}`; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="plugins-content">
    <p className="page-description">Add optional abilities to your local agent. Bundled plugins run with your model and use the permissions you choose.</p>
    <section className="plugin-card" aria-labelledby="research-plugin-title">
      <div className="plugin-card-heading">
        <span className="plugin-icon"><Icon name="search" size={23} /></span>
        <div><h2 id="research-plugin-title">Research</h2><p>Bundled · Task research</p></div>
        <span className={`plugin-status ${enabled ? 'enabled' : ''}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      <p className="plugin-description">Research a task before acting. Check project versions, compare official documentation and release notes, and include sources in the result. The agent then continues with the task using your enabled tools.</p>
      <label className="plugin-setting">
        <span><strong>Enable Research</strong><span>Research your task before the agent acts.</span></span>
        <input type="checkbox" aria-label="Enable Research" checked={enabled} disabled={disabled || !status} onChange={(event) => void onEnable(event.target.checked)} />
        <span className="toggle-track" aria-hidden="true" />
      </label>
      <label className={`plugin-setting ${enabled ? '' : 'setting-inactive'}`}>
        <span><strong>Allow web research</strong><span>Search queries and public-page reads use the internet. No approval is requested for each read. Off by default.</span></span>
        <input type="checkbox" aria-label="Allow web research" checked={internetAllowed} disabled={disabled || !status || !enabled} onChange={(event) => void onWebResearch(event.target.checked)} />
        <span className="toggle-track" aria-hidden="true" />
      </label>
      <div className="plugin-permission-note" role="status"><Icon name={enabled && internetAllowed ? 'external' : 'shield'} size={15} /><span>{!enabled ? `Research is disabled. No research workflow or web tools are active.${internetAllowed ? ' Your web permission is saved for when you enable it again.' : ''}` : internetAllowed ? 'Web access is allowed. Online research also needs an agent model with validated tools. Retrieved sources include dates; the agent should verify whether they describe the latest version.' : 'Local sources only. The agent can inspect your project and selected files, and must identify facts it could not verify online.'}</span></div>
      <details className="plugin-details"><summary>Access and limitations</summary><p>Inference stays on this computer. Online research sends your search queries to a search service and fetches public pages. Project reads follow your tool preferences; file changes and commands still need approval.</p><p>A local model can miss details or cite the wrong source. Review important findings. Approved terminal commands run with your permissions and may access the network independently of this plugin.</p></details>
    </section>
    <section className="plugin-card approval-policies" aria-labelledby="approval-policies-title">
      <div className="plugin-card-heading"><span className="plugin-icon"><Icon name="shield" size={23} /></span><div><h2 id="approval-policies-title">Workspace approvals</h2><p>Remember local utility approvals</p></div></div>
      <p className="plugin-description">These policies apply only to the selected workspace. Terminal commands always require a fresh review. Revoke any remembered utility below.</p>
      {!status?.projectPath && <p className="muted">Choose a workspace before saving an approval policy.</p>}
      {approvalUtilities.map(utility => {
        const granted = !!status?.projectPath && (status.approvalPolicies ?? []).some(policy => policy.workspacePath === status.projectPath && policy.utility === utility.id);
        return <label className={`plugin-setting ${!status?.projectPath ? 'setting-inactive' : ''}`} key={utility.id}>
          <span><strong>{utility.label}</strong><span>{utility.description}</span></span>
          <input type="checkbox" aria-label={`Always approve ${utility.label}`} checked={granted} disabled={disabled || !status?.projectPath} onChange={event => void (event.target.checked ? onSetApproval(utility.id) : onRevokeApproval(utility.id))} />
          <span className="toggle-track" aria-hidden="true" />
        </label>;
      })}
      {status?.projectPath && (status.approvalPolicies ?? []).some(policy => policy.workspacePath === status.projectPath) && <button type="button" className="text-button" disabled={disabled} onClick={() => void onRevokeApproval()}><Icon name="close" size={14} />Revoke all for this workspace</button>}
    </section>
    <section className="plugin-card research-notebook" aria-labelledby="research-notebook-title">
      <div className="plugin-card-heading"><span className="plugin-icon"><Icon name="search" size={23} /></span><div><h2 id="research-notebook-title">Research notebook</h2><p>Workspace-local evidence</p></div></div>
      <p className="plugin-description">Save cited research summaries for this workspace and reuse them as local context. The notebook never changes model weights or trains the model.</p>
      {!status?.projectPath ? <p className="muted">Choose a workspace to view its notebook.</p> : <>
        <div className="notebook-controls"><input aria-label="Search research notebook" value={noteQuery} placeholder="Search saved sources" onChange={event => setNoteQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void searchNotes(); }} /><button type="button" className="secondary-button" disabled={disabled || notesBusy} onClick={() => void searchNotes()}>Search</button></div>
        <div className="notebook-actions"><button type="button" className="text-button" disabled={disabled || notesBusy || !notes.length} onClick={() => void exportNotes('markdown')}>Export Markdown</button><button type="button" className="text-button" disabled={disabled || notesBusy || !notes.length} onClick={() => void exportNotes('json')}>Export JSON</button><button type="button" className="text-button" disabled={disabled || notesBusy || !selectedNotes.size} onClick={() => void deleteNotes()}>Delete selected</button><button type="button" className="text-button" disabled={disabled || notesBusy || !notes.length} onClick={() => void clearNotes()}>Clear notebook</button></div>
        <div className="notebook-list" aria-live="polite">{notes.length ? notes.map(note => <label className="notebook-note" key={note.id}><input type="checkbox" checked={selectedNotes.has(note.id)} onChange={event => setSelectedNotes(current => { const next = new Set(current); if (event.target.checked) next.add(note.id); else next.delete(note.id); return next; })} /><span><strong>{note.title}</strong><small>{note.publisher ?? 'Unknown publisher'} · {new Date(note.retrievedAt).toLocaleDateString()}</small><span>{note.summary.slice(0, 240)}{note.summary.length > 240 ? '…' : ''}</span></span></label>) : <p className="muted">No saved research notes for this workspace.</p>}</div>
      </>}
    </section>
  </div>;
}
