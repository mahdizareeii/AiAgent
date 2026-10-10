import Icon from './Icons';
import type { AgentStatus } from './types';

interface Props {
  status: AgentStatus | null;
  disabled: boolean;
  onEnable: (enabled: boolean) => Promise<void>;
  onWebResearch: (enabled: boolean) => Promise<void>;
}

export default function Plugins({ status, disabled, onEnable, onWebResearch }: Props) {
  const enabled = status?.plugins.taskResearch === true;
  const internetAllowed = status?.utilities.webResearch === true;
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
        <span><strong>Enable Research</strong><span>Use this research workflow in Agent and Research tasks.</span></span>
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
  </div>;
}
