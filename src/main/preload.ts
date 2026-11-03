import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fleet', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('hub:call', method, args),
  onEvent: (fn: (e: unknown) => void) => { ipcRenderer.on('hub:event', (_e, ev) => fn(ev)); },
  onSelect: (fn: (id: string) => void) => { ipcRenderer.on('hub:select', (_e, id) => fn(id)); },
  pickProject: () => ipcRenderer.invoke('app:pickProject'),
  copy: (text: string) => ipcRenderer.invoke('app:copy', text),
  reveal: (p: string) => ipcRenderer.invoke('app:reveal', p),
  applyUpdate: () => ipcRenderer.invoke('app:applyUpdate'),
  setApiKey: (key: string | null) => ipcRenderer.invoke('app:setApiKey', key),
});
