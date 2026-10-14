import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, LocalAgentBridge } from './renderer/types.ts';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`local-agent:${method}`, ...args);
const bridge: LocalAgentBridge = {
  status: () => call('status'), setup: options => call('setup', options),
  importModel: () => call('importModel'), calibrateModel: id => call('calibrateModel', id),
  setUtilities: preferences => call('setUtilities', preferences), setPlugins: preferences => call('setPlugins', preferences),
  getApprovalPolicies: () => call('getApprovalPolicies'),
  setApprovalPolicy: options => call('setApprovalPolicy', options),
  revokeApprovalPolicy: options => call('revokeApprovalPolicy', options),
  listResearchNotes: options => call('listResearchNotes', options ?? {}),
  saveResearchNote: note => call('saveResearchNote', note),
  deleteResearchNotes: options => call('deleteResearchNotes', options),
  clearResearchNotebook: options => call('clearResearchNotebook', options ?? {}),
  exportResearchNotebook: options => call('exportResearchNotebook', options ?? {}),
  setSlowMode: enabled => call('setSlowMode', enabled),
  setExecutionPreferences: options => call('setExecutionPreferences', options),
  tryExperimentalModel: id => call('tryExperimentalModel', id), cancelModelTrial: id => call('cancelModelTrial', id),
  startModelTrial: (id, route) => call('startModelTrial', id, route),
  createModelValidationTask: id => call('createModelValidationTask', id),
  downloadModel: id => call('downloadModel', id),
  cancelDownload: () => call('cancelDownload'), selectModel: id => call('selectModel', id),
  searchOllamaModels: query => call('searchOllamaModels', query),
  selectProject: () => call('selectProject'), createProject: options => call('createProject', options),
  selectFiles: () => call('selectFiles'),
  createSession: options => call('createSession', options), loadSession: id => call('loadSession', id),
  saveDraft: options => call('saveDraft', options),
  send: options => call('send', options), cancel: id => call('cancel', id), resume: id => call('resume', id),
  approvals: id => call('approvals', id), respondPermission: options => call('respondPermission', options), undo: () => call('undo'),
  onEvent(callback) {
    const listener = (_: unknown, event: AgentEvent) => callback(event);
    ipcRenderer.on('local-agent:event', listener);
    return () => ipcRenderer.removeListener('local-agent:event', listener);
  },
};
contextBridge.exposeInMainWorld('localAgent', bridge);
