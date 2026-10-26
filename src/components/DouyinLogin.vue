<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  fetchDouyinAuthStatus,
  logoutDouyin,
  startDouyinQrLogin
} from '../api/douyinAuth'
import type { DouyinAuthPhase, DouyinAuthStatus } from '../../shared/douyinAuth'

const verificationMessage = '请在登录窗口完成官方验证，再返回此处；服务器模式下需管理员在运行设备完成验证'
const unavailableMessage = '登录组件尚未配置'

function initialStatus(): DouyinAuthStatus {
  return {
    state: 'logged_out',
    loggedIn: false,
    available: false,
    message: '正在检查抖音登录组件'
  }
}

const status = ref<DouyinAuthStatus>(initialStatus())
const statusReady = ref(false)
const statusLoading = ref(false)
const actionLoading = ref(false)
const modalOpen = ref(false)
let pollTimer: number | null = null
let requestController: AbortController | null = null
let disposed = false

const authenticated = computed(() => status.value.state === 'authenticated' && status.value.loggedIn)
const hasQrImage = computed(() => Boolean(status.value.qrImageUrl?.trim()))
const stateLabel = computed(() => {
  const labels: Record<DouyinAuthPhase, string> = {
    logged_out: '未登录',
    starting: '准备登录',
    waiting_scan: '等待扫码',
    scanned: '已扫码，等待确认',
    authenticated: status.value.loggedIn ? '已登录' : '登录状态待确认',
    expired: '二维码已过期',
    verification_required: '需要官方验证',
    unavailable: '组件未配置',
    error: '登录状态异常'
  }
  return labels[status.value.state]
})
const displayMessage = computed(() => {
  if (status.value.state === 'unavailable') return unavailableMessage
  if (status.value.state === 'verification_required') return verificationMessage
  if (status.value.state === 'authenticated' && !status.value.loggedIn) return '登录状态待确认，请重新检查'
  if (status.value.state === 'expired') return status.value.message || '二维码已过期，请刷新二维码'
  return status.value.message || stateLabel.value
})
const refreshLabel = computed(() => actionLoading.value
  ? '处理中...'
  : status.value.state === 'expired' || status.value.state === 'error'
    ? '刷新二维码'
    : '重新获取二维码')

function isPendingState(state: DouyinAuthPhase) {
  return state === 'starting' || state === 'waiting_scan' || state === 'scanned' || state === 'verification_required'
}

function abortRequest() {
  requestController?.abort()
  requestController = null
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
  abortRequest()
}

function schedulePoll() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer)
    pollTimer = null
  }
  if (!modalOpen.value || disposed || !isPendingState(status.value.state) || !status.value.sessionId) return
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    void pollAuthStatus()
  }, 2000)
}

async function pollAuthStatus() {
  if (!modalOpen.value || disposed || !isPendingState(status.value.state) || !status.value.sessionId) return
  const sessionId = status.value.sessionId
  abortRequest()
  const controller = new AbortController()
  requestController = controller
  try {
    const nextStatus = await fetchDouyinAuthStatus(sessionId, controller.signal)
    if (disposed || !modalOpen.value || status.value.sessionId !== sessionId) return
    status.value = nextStatus
  } catch (error) {
    if (controller.signal.aborted || disposed || !modalOpen.value) return
    status.value = {
      ...status.value,
      state: 'error',
      loggedIn: false,
      message: error instanceof Error ? error.message : '抖音登录状态检查失败'
    }
  } finally {
    if (requestController === controller) requestController = null
    schedulePoll()
  }
}

async function refreshStatus() {
  statusLoading.value = true
  abortRequest()
  const controller = new AbortController()
  requestController = controller
  try {
    const nextStatus = await fetchDouyinAuthStatus(undefined, controller.signal)
    if (disposed || controller.signal.aborted) return
    status.value = nextStatus
    statusReady.value = true
    if (modalOpen.value && isPendingState(nextStatus.state)) schedulePoll()
  } catch (error) {
    if (controller.signal.aborted || disposed) return
    statusReady.value = true
    status.value = {
      ...initialStatus(),
      state: 'error',
      message: error instanceof Error ? error.message : '抖音登录状态检查失败'
    }
  } finally {
    if (requestController === controller) requestController = null
    statusLoading.value = false
  }
}

async function beginQrLogin(force = false) {
  if (actionLoading.value || disposed || !modalOpen.value) return
  if (status.value.state === 'unavailable' || !status.value.available) return
  stopPolling()
  actionLoading.value = true
  const available = status.value.available
  status.value = {
    state: 'starting',
    loggedIn: false,
    available,
    message: '正在准备抖音扫码登录'
  }
  const controller = new AbortController()
  requestController = controller
  try {
    const nextStatus = await startDouyinQrLogin(force, controller.signal)
    if (disposed || controller.signal.aborted || !modalOpen.value) return
    status.value = nextStatus
  } catch (error) {
    if (controller.signal.aborted || disposed || !modalOpen.value) return
    status.value = {
      state: 'error',
      loggedIn: false,
      available,
      message: error instanceof Error ? error.message : '抖音扫码登录失败'
    }
  } finally {
    if (requestController === controller) requestController = null
    actionLoading.value = false
    schedulePoll()
  }
}

async function openLoginModal() {
  modalOpen.value = true
  if (!statusReady.value) await refreshStatus()
  if (disposed || !modalOpen.value || authenticated.value) return
  if (status.value.state === 'unavailable' || !status.value.available) return
  if (isPendingState(status.value.state) && status.value.sessionId) {
    schedulePoll()
    return
  }
  await beginQrLogin(status.value.state === 'expired' || status.value.state === 'error')
}

function closeLoginModal() {
  modalOpen.value = false
  stopPolling()
}

async function refreshQrLogin() {
  await beginQrLogin(true)
}

async function logout() {
  if (actionLoading.value || disposed) return
  stopPolling()
  actionLoading.value = true
  const available = status.value.available
  const controller = new AbortController()
  requestController = controller
  try {
    const nextStatus = await logoutDouyin(controller.signal)
    if (disposed || controller.signal.aborted) return
    status.value = nextStatus
    statusReady.value = true
  } catch (error) {
    if (controller.signal.aborted || disposed) return
    status.value = {
      state: 'error',
      loggedIn: false,
      available,
      message: error instanceof Error ? error.message : '退出抖音登录失败'
    }
  } finally {
    if (requestController === controller) requestController = null
    actionLoading.value = false
  }
}

onMounted(() => {
  void refreshStatus()
})

onBeforeUnmount(() => {
  disposed = true
  modalOpen.value = false
  stopPolling()
})
</script>

<template>
  <section class="douyin-login" aria-labelledby="douyin-login-title">
    <div class="douyin-login-main">
      <div>
        <h2 id="douyin-login-title">抖音登录</h2>
        <p class="douyin-login-description">使用抖音App扫码确认，本下载器将保存登录态供解析下载；可随时退出。</p>
        <p class="douyin-login-status" data-testid="douyin-auth-status" aria-live="polite">
          状态：{{ authenticated ? '已登录' : (statusLoading && !statusReady ? '检查中...' : stateLabel) }}
        </p>
      </div>
      <button class="douyin-login-button" type="button" :disabled="statusLoading && !statusReady" @click="openLoginModal">
        登录抖音
      </button>
    </div>
    <p v-if="statusReady && status.state === 'unavailable'" class="douyin-login-note">{{ unavailableMessage }}</p>
    <p v-else-if="statusReady && status.state === 'error'" class="douyin-login-note douyin-login-error">{{ displayMessage }}</p>

    <div
      v-if="modalOpen"
      class="douyin-modal-mask"
      role="presentation"
      tabindex="-1"
      @click.self="closeLoginModal"
      @keydown.esc="closeLoginModal"
    >
      <div
        class="douyin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="douyin-dialog-title"
        aria-describedby="douyin-dialog-description"
      >
        <div class="douyin-modal-header">
          <h3 id="douyin-dialog-title">登录抖音</h3>
          <button class="douyin-close-button" type="button" aria-label="关闭抖音登录窗口" @click="closeLoginModal">×</button>
        </div>
        <p id="douyin-dialog-description" class="douyin-login-description">使用抖音App扫码确认，本下载器将保存登录态供解析下载；可随时退出。</p>

        <div class="douyin-auth-state" aria-live="polite">
          <strong>{{ authenticated ? '已登录' : stateLabel }}</strong>
          <p v-if="!authenticated">{{ displayMessage }}</p>
          <p v-else>抖音登录态已保存，可用于解析下载。</p>
        </div>

        <div v-if="hasQrImage && !authenticated" class="douyin-qr-box">
          <img :src="status.qrImageUrl" alt="抖音官方扫码登录二维码" />
          <p>请使用抖音App扫码确认。</p>
        </div>
        <p v-else-if="!authenticated && isPendingState(status.state)" class="douyin-qr-placeholder">正在等待官方二维码或登录确认...</p>
        <p v-else-if="!authenticated && status.state === 'unavailable'" class="douyin-login-note">{{ unavailableMessage }}</p>
        <p v-if="!authenticated && status.state === 'verification_required'" class="douyin-verification-note">{{ verificationMessage }}</p>

        <div class="douyin-modal-actions">
          <button
            v-if="!authenticated && status.state !== 'unavailable'"
            class="douyin-secondary-button"
            type="button"
            :disabled="actionLoading || statusLoading"
            @click="refreshQrLogin"
          >
            {{ refreshLabel }}
          </button>
          <button v-if="authenticated" class="douyin-secondary-button" type="button" :disabled="actionLoading" @click="logout">
            {{ actionLoading ? '退出中...' : '退出抖音登录' }}
          </button>
          <button class="douyin-primary-button" type="button" @click="closeLoginModal">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.douyin-login {
  margin-bottom: 20px;
  padding: 16px 18px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #f8fbff;
}

.douyin-login-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.douyin-login h2 {
  margin: 0;
  color: #0f172a;
  font-size: 16px;
  font-weight: 650;
}

.douyin-login-description,
.douyin-login-status,
.douyin-login-note,
.douyin-auth-state p,
.douyin-qr-box p,
.douyin-qr-placeholder,
.douyin-verification-note {
  margin: 6px 0 0;
  color: #475569;
  font-size: 13px;
  line-height: 1.55;
}

.douyin-login-status {
  color: #047857;
  font-weight: 650;
}

.douyin-login-note {
  color: #64748b;
}

.douyin-login-error {
  color: #b91c1c;
}

.douyin-login-button,
.douyin-primary-button,
.douyin-secondary-button,
.douyin-close-button {
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}

.douyin-login-button,
.douyin-primary-button {
  padding: 10px 18px;
  color: #ffffff;
  background: #2563eb;
  font-size: 14px;
  font-weight: 650;
}

.douyin-login-button:hover:not(:disabled),
.douyin-primary-button:hover:not(:disabled) {
  background: #1d4ed8;
}

.douyin-secondary-button {
  padding: 9px 14px;
  color: #334155;
  background: #e2e8f0;
  font-size: 14px;
  font-weight: 600;
}

.douyin-secondary-button:hover:not(:disabled) {
  color: #1d4ed8;
  background: #dbeafe;
}

.douyin-login-button:disabled,
.douyin-primary-button:disabled,
.douyin-secondary-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.douyin-modal-mask {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgb(15 23 42 / 0.45);
}

.douyin-modal {
  width: min(440px, 100%);
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  padding: 22px;
  background: #ffffff;
  border-radius: 10px;
  box-shadow: 0 20px 45px rgb(15 23 42 / 0.22);
}

.douyin-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.douyin-modal-header h3 {
  margin: 0;
  color: #0f172a;
  font-size: 18px;
  font-weight: 650;
}

.douyin-close-button {
  width: 32px;
  height: 32px;
  color: #64748b;
  background: #f1f5f9;
  font-size: 24px;
  line-height: 1;
}

.douyin-auth-state {
  margin-top: 16px;
  padding: 12px;
  border-radius: 8px;
  background: #f8fafc;
}

.douyin-auth-state strong {
  color: #0f172a;
}

.douyin-auth-state p {
  margin-top: 4px;
}

.douyin-qr-box {
  margin-top: 16px;
  text-align: center;
}

.douyin-qr-box img {
  display: block;
  width: min(280px, 100%);
  aspect-ratio: 1;
  margin: 0 auto;
  object-fit: contain;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
}

.douyin-qr-placeholder {
  margin-top: 16px;
  padding: 22px 12px;
  text-align: center;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
}

.douyin-verification-note {
  margin-top: 14px;
  color: #92400e;
}

.douyin-modal-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

@media (max-width: 700px) {
  .douyin-login-main {
    align-items: stretch;
    flex-direction: column;
  }

  .douyin-login-button,
  .douyin-primary-button,
  .douyin-secondary-button {
    width: 100%;
  }

  .douyin-modal-mask {
    align-items: flex-end;
    padding: 12px;
  }

  .douyin-modal {
    width: 100%;
    max-height: calc(100vh - 24px);
    padding: 18px;
  }

  .douyin-modal-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}
</style>
