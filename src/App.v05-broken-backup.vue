<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  addDownloadTask as addDownloaderTask,
  fetchDownloadTasks,
  openDownloadDir,
  pauseDownloadTask,
  removeDownloadTask,
  resumeDownloadTask
} from './api/downloads'
import {
  createQuarkAuthQrcode,
  fetchDownloadUrl,
  fetchFolderFiles,
  fetchQuarkAuthStatus,
  fetchShareFiles,
  logoutQuarkAuth
} from './api/quark'
import type {
  DownloadResult,
  DownloadTask,
  DownloadTasksResult,
  QuarkAuthQrcodeResult,
  QuarkAuthStatusResult,
  QuarkFile
} from '../shared/types'

interface PathItem {
  fid: string
  name: string
}

const shareUrl = ref('')
const passcode = ref('')
const shareId = ref('')
const stoken = ref('')
const files = ref<QuarkFile[]>([])
const pathStack = ref<PathItem[]>([])
const loading = ref(false)
const folderLoadingFid = ref('')
const downloadLoadingFid = ref('')
const errorMessage = ref('')
const noticeMessage = ref('')
const downloadDialog = ref<DownloadResult | null>(null)
const authDialog = ref<QuarkAuthQrcodeResult | null>(null)
const authStatus = ref<QuarkAuthStatusResult | null>(null)
const authLoading = ref(false)
const authSessionId = ref('')
const downloadTasks = ref<DownloadTask[]>([])
const downloaderEnabled = ref(false)
const downloaderMessage = ref('')
const downloaderDefaultDir = ref('')
const taskActionGid = ref('')

let authPollTimer: number | undefined
let taskPollTimer: number | undefined

const hasFiles = computed(() => files.value.length > 0)
const canGoBack = computed(() => pathStack.value.length > 0)
const currentDateLabel = computed(() => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
})

function clearMessages() {
  errorMessage.value = ''
  noticeMessage.value = ''
}

function normalizeShareUrlInput(value: string) {
  const trimmed = String(value || '').trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed) return ''

  if (/^pan\.quark\.cn\/s\//i.test(trimmed)) {
    return `https://${trimmed}`
  }

  const matched = trimmed.match(/https?:\/\/pan\.quark\.cn\/s\/[^\s"'<>]+/i)
  return matched ? matched[0] : trimmed
}

function validateQuarkUrl(value: string) {
  const trimmed = normalizeShareUrlInput(value)
  if (!trimmed) return 'Please enter a Quark share URL'

  try {
    const url = new URL(trimmed)
    if (!/pan\.quark\.cn$/i.test(url.hostname)) {
      return 'Only Quark share URLs are supported'
    }
    if (!/\/s\/[^/?#]+/.test(url.pathname)) {
      return 'Could not detect a Quark share ID'
    }
  } catch {
    return 'Invalid share URL format'
  }

  return ''
}

function formatSize(size: number) {
  if (!size) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function formatSpeed(speed: number) {
  return `${formatSize(speed)}/s`
}

async function refreshDownloadTasks(silent = false) {
  try {
    const result: DownloadTasksResult = await fetchDownloadTasks()
    downloaderEnabled.value = result.enabled
    downloaderMessage.value = result.message || ''
    downloaderDefaultDir.value = result.defaultDir
    downloadTasks.value = result.tasks
  } catch (error) {
    downloaderEnabled.value = false
    downloadTasks.value = []
    downloaderMessage.value = error instanceof Error ? error.message : 'Built-in downloader unavailable'
    if (!silent) {
      errorMessage.value = downloaderMessage.value
    }
  }
}

function stopAuthPolling() {
  if (authPollTimer) {
    window.clearInterval(authPollTimer)
    authPollTimer = undefined
  }
}

function stopTaskPolling() {
  if (taskPollTimer) {
    window.clearInterval(taskPollTimer)
    taskPollTimer = undefined
  }
}

async function loadShare() {
  clearMessages()
  downloadDialog.value = null
  const normalizedShareUrl = normalizeShareUrlInput(shareUrl.value)
  const validationError = validateQuarkUrl(normalizedShareUrl)
  if (validationError) {
    errorMessage.value = validationError
    return
  }

  loading.value = true
  try {
    shareUrl.value = normalizedShareUrl
    const result = await fetchShareFiles(normalizedShareUrl, passcode.value.trim())
    shareId.value = result.shareId
    stoken.value = result.stoken
    files.value = result.files
    pathStack.value = []
    noticeMessage.value = `Loaded ${result.files.length} item(s)`
  } catch (error) {
    files.value = []
    pathStack.value = []
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load files'
  } finally {
    loading.value = false
  }
}

async function enterFolder(file: QuarkFile) {
  if (!file.isDir || !shareId.value || !stoken.value) return
  clearMessages()
  folderLoadingFid.value = file.fid
  try {
    const result = await fetchFolderFiles(shareId.value, stoken.value, file.fid)
    pathStack.value = [...pathStack.value, { fid: file.fid, name: file.name }]
    files.value = result.files
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to open folder'
  } finally {
    folderLoadingFid.value = ''
  }
}

async function goBack() {
  if (!canGoBack.value || !shareId.value || !stoken.value) return
  clearMessages()
  loading.value = true
  try {
    const nextStack = pathStack.value.slice(0, -1)
    const parent = nextStack[nextStack.length - 1]
    const result = await fetchFolderFiles(shareId.value, stoken.value, parent?.fid)
    pathStack.value = nextStack
    files.value = result.files
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to go back'
  } finally {
    loading.value = false
  }
}

async function openDownload(file: QuarkFile) {
  if (file.isDir || !shareId.value || !stoken.value) return
  clearMessages()
  downloadDialog.value = null
  downloadLoadingFid.value = file.fid
  try {
    downloadDialog.value = await fetchDownloadUrl(shareId.value, stoken.value, file, authSessionId.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to fetch download info'
  } finally {
    downloadLoadingFid.value = ''
  }
}

async function copyDownloadUrl() {
  if (!downloadDialog.value?.downloadUrl) return
  await navigator.clipboard.writeText(downloadDialog.value.downloadUrl)
  noticeMessage.value = 'Direct download URL copied'
}

async function copyProxyDownloadUrl() {
  if (!downloadDialog.value?.proxyUrl) return
  const href = new URL(downloadDialog.value.proxyUrl, window.location.origin).toString()
  await navigator.clipboard.writeText(href)
  noticeMessage.value = 'Proxy download URL copied'
}

function startBrowserDownload() {
  const targetUrl = downloadDialog.value?.proxyUrl || downloadDialog.value?.downloadUrl
  if (!targetUrl) return
  const href = new URL(targetUrl, window.location.origin).toString()
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
}

async function useBuiltInDownloader() {
  if (!downloadDialog.value) return

  clearMessages()
  const url = downloadDialog.value.proxyUrl || downloadDialog.value.downloadUrl
  if (!url) {
    errorMessage.value = 'No download URL available'
    return
  }

  try {
    await addDownloaderTask({
      url,
      fileName: downloadDialog.value.name
    })
    noticeMessage.value = 'Added to the download queue'
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to add download task'
  }
}

function closeAuthDialog() {
  authDialog.value = null
  stopAuthPolling()
}

async function startQrLogin() {
  clearMessages()
  stopAuthPolling()
  authLoading.value = true
  try {
    const result = await createQuarkAuthQrcode()
    authDialog.value = result
    authStatus.value = {
      sessionId: result.sessionId,
      status: 'waiting',
      message: 'Waiting for QR confirmation',
      expiresAt: result.expiresAt
    }
    authPollTimer = window.setInterval(pollQrLoginStatus, 2000)
    await pollQrLoginStatus()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to create QR login'
  } finally {
    authLoading.value = false
  }
}

async function pollQrLoginStatus() {
  if (!authDialog.value) return
  try {
    const result = await fetchQuarkAuthStatus(authDialog.value.sessionId)
    authStatus.value = result
    if (result.status === 'logged_in') {
      authSessionId.value = result.sessionId
      noticeMessage.value = 'Quark account login is active for download requests'
      stopAuthPolling()
      authDialog.value = null
    }
    if (result.status === 'expired' || result.status === 'failed') {
      stopAuthPolling()
    }
  } catch (error) {
    stopAuthPolling()
    errorMessage.value = error instanceof Error ? error.message : 'Failed to poll QR status'
  }
}

async function logoutQrLogin() {
  clearMessages()
  if (authSessionId.value) {
    await logoutQuarkAuth(authSessionId.value)
  }
  authSessionId.value = ''
  authStatus.value = null
  authDialog.value = null
  stopAuthPolling()
  noticeMessage.value = 'QR login session cleared'
}

async function toggleDownloadTask(task: DownloadTask) {
  clearMessages()
  taskActionGid.value = task.gid
  try {
    if (task.status === 'paused') {
      await resumeDownloadTask(task.gid)
    } else {
      await pauseDownloadTask(task.gid)
    }
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to update download task'
  } finally {
    taskActionGid.value = ''
  }
}

async function deleteDownloadTask(task: DownloadTask) {
  clearMessages()
  taskActionGid.value = task.gid
  try {
    await removeDownloadTask(task.gid)
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to remove download task'
  } finally {
    taskActionGid.value = ''
  }
}

async function openDownloaderDir() {
  clearMessages()
  try {
    const result = await openDownloadDir()
    noticeMessage.value = `Download directory: ${result.dir}`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to open download directory'
  }
}

onMounted(() => {
  void refreshDownloadTasks(true)
  taskPollTimer = window.setInterval(() => {
    void refreshDownloadTasks(true)
  }, 1000)
})

onBeforeUnmount(() => {
  stopAuthPolling()
  stopTaskPolling()
})
</script>

<template>
  <div class="page-shell">
    <main class="container">
      <header class="page-header">
        <div class="title-row">
          <div class="title-icon" aria-hidden="true">Q</div>
          <h1>Quark Desktop Downloader</h1>
        </div>
        <p>{{ currentDateLabel }} | Web MVP + embedded desktop downloader</p>
      </header>

      <section class="panel parser-panel">
        <div class="form-row">
          <label for="share-url">Share URL</label>
          <input
            id="share-url"
            v-model="shareUrl"
            type="text"
            placeholder="Paste a Quark share URL"
            :disabled="loading"
          />
        </div>
        <div class="form-row">
          <label for="passcode">Passcode</label>
          <input
            id="passcode"
            v-model="passcode"
            type="text"
            placeholder="Optional"
            :disabled="loading"
          />
        </div>
        <div class="actions">
          <button class="primary-button" type="button" :disabled="loading" @click="loadShare">
            {{ loading ? 'Loading...' : 'Load files' }}
          </button>
          <button
            v-if="!authSessionId"
            class="ghost-button"
            type="button"
            :disabled="authLoading"
            @click="startQrLogin"
          >
            {{ authLoading ? 'Loading QR...' : 'QR login' }}
          </button>
          <button v-else class="ghost-button" type="button" @click="logoutQrLogin">
            Logged in, logout
          </button>
        </div>
      </section>

      <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>
      <p v-if="noticeMessage" class="message success">{{ noticeMessage }}</p>

      <section class="panel file-panel">
        <div class="table-header">
          <div>
            <h2>Files</h2>
            <p v-if="pathStack.length" class="path-text">
              / {{ pathStack.map((item) => item.name).join(' / ') }}
            </p>
          </div>
          <button class="ghost-button" type="button" :disabled="!canGoBack || loading" @click="goBack">
            Back
          </button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Folder</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in files" :key="file.fid">
                <td>
                  <span class="file-name" :title="file.name">
                    <span class="file-icon">{{ file.isDir ? '[DIR]' : '[FILE]' }}</span>
                    {{ file.name }}
                  </span>
                </td>
                <td>{{ formatSize(file.size) }}</td>
                <td>{{ file.isDir ? 'Yes' : 'No' }}</td>
                <td>
                  <button
                    v-if="file.isDir"
                    class="row-button"
                    type="button"
                    :disabled="Boolean(folderLoadingFid)"
                    @click="enterFolder(file)"
                  >
                    {{ folderLoadingFid === file.fid ? 'Opening...' : 'Open folder' }}
                  </button>
                  <button
                    v-else
                    class="row-button"
                    type="button"
                    :disabled="Boolean(downloadLoadingFid)"
                    @click="openDownload(file)"
                  >
                    {{ downloadLoadingFid === file.fid ? 'Loading...' : 'Get download' }}
                  </button>
                </td>
              </tr>
              <tr v-if="!loading && !hasFiles">
                <td class="empty-cell" colspan="4">
                  <div class="empty-state">
                    <div class="empty-icon">[]</div>
                    <p>No files loaded</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel task-panel">
        <div class="table-header">
          <div>
            <h2>Downloads</h2>
            <p class="path-text">{{ downloaderDefaultDir || 'Preparing download directory...' }}</p>
          </div>
          <button class="ghost-button" type="button" @click="openDownloaderDir">Open folder</button>
        </div>

        <div v-if="!downloaderEnabled" class="downloader-status">
          {{ downloaderMessage || 'Built-in downloader unavailable' }}
        </div>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Speed</th>
                <th>Downloaded</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in downloadTasks" :key="task.gid">
                <td>{{ task.fileName }}</td>
                <td>{{ task.status }}</td>
                <td>
                  <div class="task-progress">
                    <div class="task-progress-bar">
                      <span :style="{ width: `${task.progress}%` }"></span>
                    </div>
                    <span class="task-progress-label">{{ task.progress }}%</span>
                  </div>
                </td>
                <td>{{ formatSpeed(task.downloadSpeed) }}</td>
                <td>{{ formatSize(task.completedLength) }} / {{ formatSize(task.totalLength) }}</td>
                <td class="task-actions">
                  <button
                    class="row-button"
                    type="button"
                    :disabled="taskActionGid === task.gid || !['active', 'paused'].includes(task.status)"
                    @click="toggleDownloadTask(task)"
                  >
                    {{ task.status === 'paused' ? 'Resume' : 'Pause' }}
                  </button>
                  <button
                    class="ghost-button"
                    type="button"
                    :disabled="taskActionGid === task.gid"
                    @click="deleteDownloadTask(task)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
              <tr v-if="!downloadTasks.length">
                <td class="empty-cell" colspan="6">
                  <div class="empty-state">
                    <div class="empty-icon">↓</div>
                    <p>No download tasks yet</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <div v-if="downloadDialog" class="modal-mask" @click.self="downloadDialog = null">
      <div class="modal">
        <div class="modal-header">
          <h3>Download ready</h3>
          <button class="icon-button" type="button" aria-label="Close" @click="downloadDialog = null">
            x
          </button>
        </div>
        <p class="modal-file">{{ downloadDialog.name }}</p>
        <template v-if="downloadDialog.source === 'direct' && downloadDialog.downloadUrl">
          <textarea readonly :value="downloadDialog.downloadUrl"></textarea>
        </template>
        <template v-else>
          <div class="proxy-download-note">This file will be delivered through the local proxy.</div>
        </template>
        <p class="cache-note">
          {{ downloadDialog.cached ? 'Server cache hit' : 'Fresh link created' }},
          expires at {{ new Date(downloadDialog.expiresAt).toLocaleString() }}
        </p>
        <div class="modal-actions">
          <button class="ghost-button" type="button" @click="downloadDialog = null">Close</button>
          <button
            v-if="downloadDialog.source === 'direct'"
            class="ghost-button"
            type="button"
            @click="startBrowserDownload"
          >
            Browser download
          </button>
          <button
            v-if="downloadDialog.source === 'direct'"
            class="ghost-button"
            type="button"
            @click="copyDownloadUrl"
          >
            Copy direct URL
          </button>
          <button
            v-if="downloadDialog.source !== 'direct'"
            class="ghost-button"
            type="button"
            @click="startBrowserDownload"
          >
            Browser download
          </button>
          <button
            v-if="downloadDialog.source !== 'direct'"
            class="ghost-button"
            type="button"
            @click="copyProxyDownloadUrl"
          >
            Copy proxy URL
          </button>
          <button class="primary-button" type="button" @click="useBuiltInDownloader">
            Use built-in downloader
          </button>
        </div>
      </div>
    </div>

    <div v-if="authDialog" class="modal-mask" @click.self="closeAuthDialog">
      <div class="modal auth-modal">
        <div class="modal-header">
          <h3>QR login</h3>
          <button class="icon-button" type="button" aria-label="Close" @click="closeAuthDialog">
            x
          </button>
        </div>
        <div class="qr-box">
          <img :src="authDialog.qrImageUrl" alt="Quark QR code" />
          <p>{{ authStatus?.message || 'Waiting for QR confirmation' }}</p>
          <a :href="authDialog.qrLoginUrl" target="_blank" rel="noreferrer">Open QR link</a>
        </div>
        <div class="modal-actions">
          <button class="ghost-button" type="button" @click="startQrLogin">Refresh QR</button>
          <button class="primary-button" type="button" @click="pollQrLoginStatus">Check status</button>
        </div>
      </div>
    </div>
  </div>
</template>
