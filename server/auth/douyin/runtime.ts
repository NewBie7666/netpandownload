import { DouyinAuthManager } from './manager.js'
import { PlaywrightDouyinBrowserDriver } from './browserDriver.js'
import { getDefaultDouyinStore } from './sessionStore.js'
import { clearDouyinTemporaryCredentials } from './credentials.js'
import { douyinProvider } from '../../providers/socialProvider.js'

let manager: DouyinAuthManager | undefined
export function getDouyinAuthManager() {
  if (!manager) {
    manager = new DouyinAuthManager({
      store: getDefaultDouyinStore(), driver: new PlaywrightDouyinBrowserDriver(),
      onLogout: async () => { douyinProvider.clearCache(); await clearDouyinTemporaryCredentials() },
      onAuthenticated: () => { douyinProvider.clearCache() }
    })
  }
  return manager
}
