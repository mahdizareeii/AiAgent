import Icon from './Icons';
import type { Mode, UtilityPreferences } from './types';

const utilities: { id: keyof UtilityPreferences; label: string; icon: 'folder' | 'search' | 'code' | 'monitor' | 'external'; description: string; modes?: Mode[]; review?: boolean }[] = [
  { id: 'fileReading', label: 'Read files & PDFs', icon: 'folder', description: 'Read selected text, code, and text PDFs. Reads need no further approval after you grant access. Scanned pages need OCR.', },
  { id: 'projectSearch', label: 'Search project', icon: 'search', description: 'Find filenames and text in your selected project. Read-only searches need no further approval.', modes: ['coding'] },
  { id: 'fileEditing', label: 'Create & edit files', icon: 'code', description: 'Create project files and propose changes for your approval.', modes: ['coding'], review: true },
  { id: 'terminal', label: 'Terminal', icon: 'monitor', description: 'Approved commands run as you and may access the network or files beyond this project.', modes: ['coding'], review: true },
];

export default function Utilities({ preferences, mode, toolCapable, projectSelected = false, calibrated = false, disabled, onChange }: { preferences: UtilityPreferences; mode: Mode; toolCapable?: boolean; projectSelected?: boolean; calibrated?: boolean; disabled: boolean; onChange: (preferences: UtilityPreferences) => Promise<void> }) {
  return <div className="utility-cards" role="group" aria-label="Agent tool preferences">{utilities.map((utility) => {
    const availableInMode = !utility.modes || utility.modes.includes(mode);
    const availableForModel = utility.id === 'fileReading' || toolCapable !== false;
    const workspaceReady = !utility.modes || utility.modes.length !== 1 || utility.modes[0] !== 'coding' || projectSelected;
    const modelReady = utility.id === 'fileReading' || calibrated;
    const active = preferences[utility.id] && availableInMode && availableForModel && workspaceReady && modelReady;
    const scope = utility.modes?.[0] === 'coding' ? 'Agent only' : 'All modes';
    const availability = preferences[utility.id] ? !availableForModel ? 'Needs an agent model' : !availableInMode ? 'Enabled' : !workspaceReady ? 'Choose workspace' : !modelReady ? 'Check tools & speed' : 'Active' : 'Off';
    return <label className={`utility-card ${active ? 'utility-enabled' : ''}`} key={utility.id}>
      <div className="utility-card-title"><Icon name={utility.icon} size={16} /><span>{utility.label}</span><input type="checkbox" checked={preferences[utility.id]} disabled={disabled} onChange={(event) => void onChange({ ...preferences, [utility.id]: event.target.checked })} aria-label={`Enable ${utility.label.toLowerCase()} (${scope.toLowerCase()})`} /><span className="toggle-track" aria-hidden="true" /></div>
      <p>{utility.description}</p><span className={`utility-scope ${active ? 'utility-active' : ''}`}>{scope} · {availability}</span>{utility.review && <span className="utility-approval">Approval for every action</span>}
    </label>;
  })}</div>;
}
