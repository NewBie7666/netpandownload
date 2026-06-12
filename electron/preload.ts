import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopApi', {
  selectDownloadDir: () => ipcRenderer.invoke('select-download-dir') as Promise<string | null>
})
