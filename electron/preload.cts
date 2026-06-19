const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApi', {
  selectDownloadDir: () => ipcRenderer.invoke('select-download-dir') as Promise<string | null>,
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
