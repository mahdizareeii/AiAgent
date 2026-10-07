import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, LocalAgentBridge } from './renderer/types.ts';
const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`local-agent:${method}`, ...args);
const bridge: LocalAgentBridge = {
  status: () => call('status'), setup: options => call('setup', options),
  importModel: () => call('importModel'), calibrateModel: id => call('calibrateModel', id),
  setUtilities: preferences => call('setUtilities', preferences), setSlowMode: enabled => call('setSlowMode', enabled),
  downloadModel: id => call('downloadModel', id),
  cancelDownload: () => call('cancelDownload'), selectModel: id => call('selectModel', id),
  selectProject: () => call('selectProject'), selectFiles: () => call('selectFiles'),
  createSession: options => call('createSession', options), loadSession: id => call('loadSession', id),
  send: options => call('send', options), cancel: id => call('cancel', id), resume: id => call('resume', id),
  respondPermission: options => call('respondPermission', options), undo: () => call('undo'),
  onEvent(callback) {
    const listener = (_: unknown, event: AgentEvent) => callback(event);
    ipcRenderer.on('local-agent:event', listener);
    return () => ipcRenderer.removeListener('local-agent:event', listener);
  },
};
contextBridge.exposeInMainWorld('localAgent', bridge);
