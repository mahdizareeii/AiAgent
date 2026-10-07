import Icon from './Icons';
import type { Mode, UtilityPreferences } from './types';

const utilities: { id: keyof UtilityPreferences; label: string; icon: 'folder' | 'search' | 'code' | 'monitor' | 'external'; description: string; mode?: Mode; review?: boolean }[] = [
  { id: 'fileReading', label: 'Read files & PDFs', icon: 'folder', description: 'Read selected text, code, and text PDFs. Reads need no further approval after you grant access. Scanned pages need OCR.', },
  { id: 'projectSearch', label: 'Search project', icon: 'search', description: 'Find filenames and text in your selected project. Read-only searches need no further approval.', mode: 'coding' },
  { id: 'fileEditing', label: 'Edit files', icon: 'code', description: 'Propose file changes for your approval.', mode: 'coding', review: true },
  { id: 'terminal', label: 'Terminal', icon: 'monitor', description: 'Approved commands run as you and may access the network or files beyond this project.', mode: 'coding', review: true },
  { id: 'webResearch', label: 'Web research', icon: 'external', description: 'When enabled, search the internet and read public pages without approval for each read.', mode: 'research' },
];

export default function Utilities({ preferences, mode, toolCapable, disabled, onChange }: { preferences: UtilityPreferences; mode: Mode; toolCapable?: boolean; disabled: boolean; onChange: (preferences: UtilityPreferences) => Promise<void> }) {
  return <div className="utility-cards" role="group" aria-label="Agent tool preferences">{utilities.map((utility) => {
    const availableInMode = !utility.mode || utility.mode === mode;
    const availableForModel = utility.id === 'fileReading' || toolCapable !== false;
    const active = preferences[utility.id] && availableInMode && availableForModel;
    const scope = utility.mode === 'coding' ? 'Coding only' : utility.mode === 'research' ? 'Research only' : 'All modes';
    const availability = preferences[utility.id] ? !availableForModel ? 'Needs an agent model' : active ? 'Active' : 'Enabled' : 'Off';
    return <label className={`utility-card ${active ? 'utility-enabled' : ''}`} key={utility.id}>
      <div className="utility-card-title"><Icon name={utility.icon} size={16} /><span>{utility.label}</span><input type="checkbox" checked={preferences[utility.id]} disabled={disabled} onChange={(event) => void onChange({ ...preferences, [utility.id]: event.target.checked })} aria-label={`Enable ${utility.label.toLowerCase()} (${scope.toLowerCase()})`} /><span className="toggle-track" aria-hidden="true" /></div>
      <p>{utility.description}</p><span className={`utility-scope ${active ? 'utility-active' : ''}`}>{scope} · {availability}</span>{utility.review && <span className="utility-approval">Approval for every action</span>}
    </label>;
  })}</div>;
}
