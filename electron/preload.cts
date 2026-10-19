const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApi', {
  selectDownloadDir: () => ipcRenderer.invoke('select-download-dir') as Promise<string | null>,
  openPageScanBrowser: (url: string) => ipcRenderer.invoke('open-page-scan-browser', url) as Promise<{ pageUrl: string }>,
  scanInteractivePage: (extensions: string) => ipcRenderer.invoke('scan-interactive-page', extensions) as Promise<{
    pageUrl: string
    extensions: string[]
    items: Array<{ url: string, fileName: string, extension: string }>
    truncated: boolean
  }>,
  loginBilibili: () => ipcRenderer.invoke('bilibili-login') as Promise<{
    status: 'success' | 'failed' | 'cancelled'
    loggedIn: boolean
    message?: string
  }>,
  getBilibiliLoginStatus: () => ipcRenderer.invoke('bilibili-login-status') as Promise<{
    loggedIn: boolean
    cookieValid: boolean
    lastLoginTime?: number
    mode: 'anonymous' | 'cookie'
  }>,
  logoutBilibili: () => ipcRenderer.invoke('bilibili-logout') as Promise<{
    loggedIn: false
    cookieValid: false
    mode: 'anonymous'
  }>
})
