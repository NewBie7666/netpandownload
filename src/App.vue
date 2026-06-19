<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  addDownloadTask as addDownloaderTask,
  fetchDownloadTasks,
  openDownloadDir,
  pauseDownloadTask,
  removeDownloadTask,
  resumeDownloadTask,
  saveDownloadSettings
} from './api/downloads'
import {
  createQuarkAuthQrcode,
  fetchQuarkAuthStatus,
  logoutQuarkAuth
} from './api/quark'
import {
  fetchProviderDownload,
  listProviderFiles,
  resolveProviderResource
} from './api/providers'
import DownloadCenter from './views/download-center/DownloadCenter.vue'
import type {
  DownloadResult,
  DownloadTask,
  DownloadTasksResult,
  ProviderId,
  QuarkAuthQrcodeResult,
  QuarkAuthStatusResult,
  QuarkFile
} from '../shared/types'

interface PathItem {
  fid: string
  name: string
}

interface BilibiliLoginResult {
  status: 'success' | 'failed' | 'cancelled'
  loggedIn: boolean
  message?: string
}

interface BilibiliLoginStatus {
  loggedIn: boolean
  cookieValid: boolean
  lastLoginTime?: number
  mode: 'anonymous' | 'cookie'
}

declare global {
  interface Window {
    desktopApi?: {
      selectDownloadDir: () => Promise<string | null>
      loginBilibili?: () => Promise<BilibiliLoginResult>
      getBilibiliLoginStatus?: () => Promise<BilibiliLoginStatus>
      logoutBilibili?: () => Promise<BilibiliLoginStatus>
    }
  }
}

const shareUrl = ref('')
const passcode = ref('')
const currentProviderId = ref<ProviderId | ''>('')
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
const deleteTaskDialog = ref<DownloadTask | null>(null)
const selectedFileIds = ref<string[]>([])
const batchDownloadLoading = ref(false)
const batchDownloadDone = ref(0)
const batchDownloadTotal = ref(0)
const bilibiliAuthLoading = ref(false)
const bilibiliLoginStatus = ref<BilibiliLoginStatus>({
  loggedIn: false,
  cookieValid: false,
  mode: 'anonymous'
})

let authPollTimer: number | undefined
let taskPollTimer: number | undefined

const hasFiles = computed(() => files.value.length > 0)
const canGoBack = computed(() => pathStack.value.length > 0)
const selectableFiles = computed(() => files.value.filter((file) => !file.isDir))
const selectedFiles = computed(() => selectableFiles.value.filter((file) => selectedFileIds.value.includes(file.fid)))
const allSelectableSelected = computed(
  () => selectableFiles.value.length > 0 && selectableFiles.value.every((file) => selectedFileIds.value.includes(file.fid))
)
const batchDownloadProgressText = computed(() => {
  if (!batchDownloadLoading.value || !batchDownloadTotal.value) return ''
  return `正在加入下载任务：${batchDownloadDone.value} / ${batchDownloadTotal.value}`
})

function clearMessages() {
  errorMessage.value = ''
  noticeMessage.value = ''
}

function clearFileSelection() {
  selectedFileIds.value = []
}

function isFileSelected(file: QuarkFile) {
  return selectedFileIds.value.includes(file.fid)
}

function toggleFileSelection(file: QuarkFile) {
  if (file.isDir || batchDownloadLoading.value) return
  selectedFileIds.value = isFileSelected(file)
    ? selectedFileIds.value.filter((fid) => fid !== file.fid)
    : [...selectedFileIds.value, file.fid]
}

function toggleSelectAllFiles() {
  if (batchDownloadLoading.value) return
  selectedFileIds.value = allSelectableSelected.value ? [] : selectableFiles.value.map((file) => file.fid)
}

function normalizeResourceUrlInput(value: string) {
  const trimmed = String(value || '').trim().replace(/^["']|["']$/g, '')
  if (!trimmed) return ''

  if (/^pan\.quark\.cn\/s\//i.test(trimmed)) {
    return `https://${trimmed}`
  }
  if (/^(www\.)?bilibili\.com\//i.test(trimmed) || /^space\.bilibili\.com\//i.test(trimmed) || /^b23\.tv\//i.test(trimmed)) {
    return `https://${trimmed}`
  }

  const matched = trimmed.match(/https?:\/\/pan\.quark\.cn\/s\/[^\s"'<>]+/i)
    || trimmed.match(/https?:\/\/(?:www\.)?bilibili\.com\/[^\s"'<>]+/i)
    || trimmed.match(/https?:\/\/space\.bilibili\.com\/[^\s"'<>]+/i)
    || trimmed.match(/https?:\/\/b23\.tv\/[^\s"'<>]+/i)
  return matched ? matched[0] : trimmed
}

function validateResourceUrl(value: string) {
  const trimmed = normalizeResourceUrlInput(value)
  if (!trimmed) return '请输入资源链接'

  try {
    const url = new URL(trimmed)
    if (/pan\.quark\.cn$/i.test(url.hostname)) {
      if (!/\/s\/[^/?#]+/.test(url.pathname)) {
        return '未识别到夸克分享 ID'
      }
      return ''
    }
    if (/^(www\.)?bilibili\.com$/i.test(url.hostname)) {
      if (/^\/video\/BV[0-9A-Za-z]+/i.test(url.pathname) || /^\/bangumi\/play\//i.test(url.pathname)) {
        return ''
      }
      return '未识别到支持的 B 站视频链接'
    }
    if (/^space\.bilibili\.com$/i.test(url.hostname)) {
      if (/^\/\d+\/search\/?$/i.test(url.pathname)) {
        return ''
      }
      return '未识别到支持的 B 站空间搜索链接'
    }
    if (/^b23\.tv$/i.test(url.hostname) && url.pathname.length > 1) {
      return ''
    }
  } catch {
    return '资源链接格式不正确'
  }

  return '当前不支持该链接来源'
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
    downloaderMessage.value = error instanceof Error ? error.message : '内置下载器不可用'
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
  const validation = validateResourceUrl(shareUrl.value)
  if (validation) {
    errorMessage.value = validation
    return
  }

  const normalizedShareUrl = normalizeResourceUrlInput(shareUrl.value)
  loading.value = true
  try {
    shareUrl.value = normalizedShareUrl
    const result = await resolveProviderResource(normalizedShareUrl, passcode.value.trim(), authSessionId.value)
    currentProviderId.value = result.providerId
    shareId.value = result.share.shareId
    stoken.value = result.share.stoken
    files.value = result.share.files
    clearFileSelection()
    pathStack.value = []
    noticeMessage.value = `已通过 ${result.providerId === 'quark' ? '夸克' : 'Bilibili'} 获取 ${result.share.files.length} 个文件`
  } catch (error) {
    currentProviderId.value = ''
    shareId.value = ''
    stoken.value = ''
    files.value = []
    clearFileSelection()
    pathStack.value = []
    errorMessage.value = error instanceof Error ? error.message : '解析资源失败'
  } finally {
    loading.value = false
  }
}

async function enterFolder(file: QuarkFile) {
  if (!file.isDir || !currentProviderId.value || !shareId.value || !stoken.value) return
  clearMessages()
  clearFileSelection()
  folderLoadingFid.value = file.fid
  try {
    const result = await listProviderFiles(currentProviderId.value, shareId.value, stoken.value, file.fid)
    pathStack.value = [...pathStack.value, { fid: file.fid, name: file.name }]
    files.value = result.list.files
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '进入文件夹失败'
  } finally {
    folderLoadingFid.value = ''
  }
}

async function goBack() {
  if (!canGoBack.value || !currentProviderId.value || !shareId.value || !stoken.value) return
  clearMessages()
  clearFileSelection()
  loading.value = true
  try {
    const nextStack = pathStack.value.slice(0, -1)
    const parent = nextStack[nextStack.length - 1]
    const result = await listProviderFiles(currentProviderId.value, shareId.value, stoken.value, parent?.fid)
    pathStack.value = nextStack
    files.value = result.list.files
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '返回上一级失败'
  } finally {
    loading.value = false
  }
}

async function openDownload(file: QuarkFile) {
  if (file.isDir || !currentProviderId.value || !shareId.value || !stoken.value) return
  clearMessages()
  downloadDialog.value = null
  downloadLoadingFid.value = file.fid
  try {
    const result = await fetchProviderDownload(
      currentProviderId.value,
      shareId.value,
      stoken.value,
      file,
      authSessionId.value
    )
    downloadDialog.value = result.download
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '获取下载链接失败'
  } finally {
    downloadLoadingFid.value = ''
  }
}

async function copyDownloadUrl() {
  if (!downloadDialog.value?.downloadUrl) return
  await navigator.clipboard.writeText(downloadDialog.value.downloadUrl)
  noticeMessage.value = '直链已复制'
}

async function copyProxyDownloadUrl() {
  if (!downloadDialog.value?.proxyUrl) return
  const href = new URL(downloadDialog.value.proxyUrl, window.location.origin).toString()
  await navigator.clipboard.writeText(href)
  noticeMessage.value = '代理下载地址已复制'
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

function getDownloadFileName(download: DownloadResult) {
  const baseName = String(download.name || 'download').trim() || 'download'
  if (/\.[A-Za-z0-9]{2,8}$/.test(baseName)) {
    return baseName
  }

  const targetUrl = download.proxyUrl || download.downloadUrl || ''
  try {
    const pathname = new URL(targetUrl, window.location.origin).pathname
    const matched = pathname.match(/\.([A-Za-z0-9]{2,8})$/)
    if (matched?.[1]) {
      return `${baseName}.${matched[1]}`
    }
  } catch {
    // Fall through to source-based defaults.
  }

  return download.source === 'direct' ? `${baseName}.mp4` : baseName
}

async function useBuiltInDownloader() {
  if (!downloadDialog.value) return

  clearMessages()
  const url = downloadDialog.value.proxyUrl || downloadDialog.value.downloadUrl
  if (!url) {
    errorMessage.value = '没有可用的下载地址'
    return
  }

  try {
    await addDownloaderTask({
      url,
      fileName: getDownloadFileName(downloadDialog.value)
    })
    noticeMessage.value = '已加入下载任务'
    downloadDialog.value = null
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '添加下载任务失败'
  }
}

async function downloadSelectedFiles() {
  if (!currentProviderId.value || !shareId.value || !stoken.value || batchDownloadLoading.value) return

  const targets = selectedFiles.value
  if (!targets.length) {
    errorMessage.value = '请先选择要下载的文件'
    return
  }

  clearMessages()
  batchDownloadLoading.value = true
  batchDownloadDone.value = 0
  batchDownloadTotal.value = targets.length

  let successCount = 0
  let failureCount = 0

  try {
    for (const file of targets) {
      try {
        const result = await fetchProviderDownload(
          currentProviderId.value,
          shareId.value,
          stoken.value,
          file,
          authSessionId.value
        )
        const url = result.download.proxyUrl || result.download.downloadUrl
        if (!url) {
          throw new Error('没有可用的下载地址')
        }
        await addDownloaderTask({
          url,
          fileName: getDownloadFileName(result.download)
        })
        successCount += 1
      } catch {
        failureCount += 1
      } finally {
        batchDownloadDone.value += 1
      }
    }

    if (successCount > 0) {
      clearFileSelection()
      await refreshDownloadTasks(true)
    }

    if (failureCount > 0) {
      errorMessage.value = `已加入 ${successCount} 个下载任务，失败 ${failureCount} 个`
    } else {
      noticeMessage.value = `已加入 ${successCount} 个下载任务`
    }
  } finally {
    batchDownloadLoading.value = false
    batchDownloadDone.value = 0
    batchDownloadTotal.value = 0
  }
}

async function refreshBilibiliLoginStatus() {
  if (!window.desktopApi?.getBilibiliLoginStatus) {
    bilibiliLoginStatus.value = {
      loggedIn: false,
      cookieValid: false,
      mode: 'anonymous'
    }
    return
  }

  try {
    bilibiliLoginStatus.value = await window.desktopApi.getBilibiliLoginStatus()
  } catch {
    bilibiliLoginStatus.value = {
      loggedIn: false,
      cookieValid: false,
      mode: 'anonymous'
    }
  }
}

async function startBilibiliLogin() {
  clearMessages()
  if (!window.desktopApi?.loginBilibili) {
    errorMessage.value = '请在桌面客户端中登录 B 站'
    return
  }

  bilibiliAuthLoading.value = true
  try {
    const result = await window.desktopApi.loginBilibili()
    await refreshBilibiliLoginStatus()
    if (result.status === 'success' && result.loggedIn) {
      noticeMessage.value = 'B 站登录完成'
      return
    }
    if (result.status === 'cancelled') {
      noticeMessage.value = result.message || 'B 站登录已取消'
      return
    }
    errorMessage.value = result.message || 'B 站登录失败'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'B 站登录失败'
  } finally {
    bilibiliAuthLoading.value = false
  }
}

async function logoutBilibiliLogin() {
  clearMessages()
  if (!window.desktopApi?.logoutBilibili) {
    errorMessage.value = '请在桌面客户端中退出 B 站登录'
    return
  }

  bilibiliAuthLoading.value = true
  try {
    bilibiliLoginStatus.value = await window.desktopApi.logoutBilibili()
    noticeMessage.value = 'B 站登录状态已退出'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'B 站退出失败'
  } finally {
    bilibiliAuthLoading.value = false
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
      message: '等待夸克扫码确认',
      expiresAt: result.expiresAt
    }
    authPollTimer = window.setInterval(pollQrLoginStatus, 2000)
    await pollQrLoginStatus()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建夸克扫码登录失败'
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
      noticeMessage.value = '夸克账号登录态已生效'
      stopAuthPolling()
      authDialog.value = null
    }
    if (result.status === 'expired' || result.status === 'failed') {
      stopAuthPolling()
    }
  } catch (error) {
    stopAuthPolling()
    errorMessage.value = error instanceof Error ? error.message : '检查扫码状态失败'
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
  noticeMessage.value = '夸克扫码登录状态已退出'
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
    errorMessage.value = error instanceof Error ? error.message : '更新下载任务失败'
  } finally {
    taskActionGid.value = ''
  }
}

function requestDeleteDownloadTask(task: DownloadTask) {
  deleteTaskDialog.value = task
}

async function confirmDeleteDownloadTask(deleteFile: boolean) {
  const task = deleteTaskDialog.value
  if (!task) return

  clearMessages()
  taskActionGid.value = task.gid
  try {
    await removeDownloadTask(task.gid, { deleteFile })
    noticeMessage.value = deleteFile ? 'Task record and local file removed' : 'Task record removed'
    deleteTaskDialog.value = null
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除下载任务失败'
  } finally {
    taskActionGid.value = ''
  }
}

async function selectDownloadDirectory() {
  clearMessages()
  if (!window.desktopApi?.selectDownloadDir) {
    errorMessage.value = 'Please choose download directory in the desktop client'
    return
  }

  try {
    const selectedDir = await window.desktopApi.selectDownloadDir()
    if (!selectedDir) return
    const result = await saveDownloadSettings(selectedDir)
    downloaderDefaultDir.value = result.downloadDir
    noticeMessage.value = `Download directory updated: ${result.downloadDir}`
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '选择下载目录失败'
  }
}

async function openDownloaderDir() {
  clearMessages()
  try {
    const result = await openDownloadDir()
    noticeMessage.value = `Download directory opened: ${result.dir}`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '打开下载目录失败'
  }
}

function formatTaskStatus(status: DownloadTask['status']) {
  const labels: Record<DownloadTask['status'], string> = {
    active: 'Downloading',
    waiting: 'Waiting',
    paused: 'Paused',
    error: 'Failed',
    complete: 'Complete',
    removed: 'Removed'
  }
  return labels[status] || status
}

onMounted(() => {
  void refreshBilibiliLoginStatus()
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
      <section class="panel parser-panel">
        <div class="form-row">
          <label for="share-url">资源链接</label>
          <input id="share-url" v-model="shareUrl" type="text" placeholder="夸克链接、B 站视频或 B 站空间搜索链接" :disabled="loading" />
        </div>
        <div class="form-row">
          <label for="passcode">提取码</label>
          <input id="passcode" v-model="passcode" type="text" placeholder="夸克链接可填；B 站链接无需填写" :disabled="loading" />
        </div>
        <div class="actions">
          <button class="primary-button" type="button" :disabled="loading" @click="loadShare">
            {{ loading ? '解析中...' : '解析资源' }}
          </button>
          <button v-if="!authSessionId" class="ghost-button" type="button" :disabled="authLoading" @click="startQrLogin">
            {{ authLoading ? '二维码生成中...' : '夸克扫码登录' }}
          </button>
          <button v-else class="ghost-button" type="button" @click="logoutQrLogin">夸克已登录，退出</button>
          <button v-if="!bilibiliLoginStatus.loggedIn" class="ghost-button" type="button" :disabled="bilibiliAuthLoading" @click="startBilibiliLogin">
            {{ bilibiliAuthLoading ? 'B 站登录中...' : 'B站登录' }}
          </button>
          <button v-else class="ghost-button" type="button" :disabled="bilibiliAuthLoading" @click="logoutBilibiliLogin">
            B站已登录，退出
          </button>
        </div>
      </section>

      <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>
      <p v-if="noticeMessage" class="message success">{{ noticeMessage }}</p>

      <section class="panel file-panel">
        <div class="table-header">
          <div>
            <h2>文件列表</h2>
            <p v-if="pathStack.length" class="path-text">/ {{ pathStack.map((item) => item.name).join(' / ') }}</p>
            <p v-if="batchDownloadProgressText" class="path-text">{{ batchDownloadProgressText }}</p>
          </div>
          <div class="task-header-actions">
            <button class="ghost-button" type="button" :disabled="!selectableFiles.length || batchDownloadLoading" @click="toggleSelectAllFiles">
              {{ allSelectableSelected ? '取消全选' : '全选' }}
            </button>
            <button class="primary-button" type="button" :disabled="!selectedFiles.length || batchDownloadLoading || !downloaderEnabled" @click="downloadSelectedFiles">
              {{ batchDownloadLoading ? '加入中...' : `下载选中 (${selectedFiles.length})` }}
            </button>
            <button class="ghost-button" type="button" :disabled="!canGoBack || loading || batchDownloadLoading" @click="goBack">返回上一级</button>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" :checked="allSelectableSelected" :disabled="!selectableFiles.length || batchDownloadLoading" aria-label="全选当前列表文件" @change="toggleSelectAllFiles" /></th>
                <th>名称</th>
                <th>大小</th>
                <th>类型</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in files" :key="file.fid">
                <td><input type="checkbox" :checked="isFileSelected(file)" :disabled="file.isDir || batchDownloadLoading" :aria-label="`选择 ${file.name}`" @change="toggleFileSelection(file)" /></td>
                <td><span class="file-name" :title="file.name"><span class="file-icon">{{ file.isDir ? '文件夹' : '文件' }}</span> {{ file.name }}</span></td>
                <td>{{ formatSize(file.size) }}</td>
                <td>{{ file.isDir ? '文件夹' : '文件' }}</td>
                <td>
                  <button v-if="file.isDir" class="row-button" type="button" :disabled="folderLoadingFid === file.fid" @click="enterFolder(file)">
                    {{ folderLoadingFid === file.fid ? '进入中...' : '进入文件夹' }}
                  </button>
                  <button v-else class="row-button" type="button" :disabled="downloadLoadingFid === file.fid || batchDownloadLoading" @click="openDownload(file)">
                    {{ downloadLoadingFid === file.fid ? '获取中...' : '获取链接' }}
                  </button>
                </td>
              </tr>
              <tr v-if="!files.length">
                <td class="empty-cell" colspan="5">暂无文件</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel task-panel">
        <div class="table-header">
          <div>
            <h2>下载任务</h2>
            <p class="path-text">内置下载器：{{ downloaderEnabled ? '可用' : '不可用' }}</p>
            <p class="path-text">默认下载目录：{{ downloaderDefaultDir || '-' }}</p>
            <p v-if="downloaderMessage" class="path-text">{{ downloaderMessage }}</p>
          </div>
          <div class="task-header-actions">
            <button class="ghost-button" type="button" @click="selectDownloadDirectory">选择下载目录</button>
            <button class="ghost-button" type="button" @click="openDownloaderDir">打开下载目录</button>
            <button class="ghost-button" type="button" @click="refreshDownloadTasks(false)">刷新</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>文件名</th><th>状态</th><th>进度</th><th>速度</th><th>大小</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="task in downloadTasks" :key="task.gid">
                <td>{{ task.fileName }}</td>
                <td>{{ formatTaskStatus(task.status) }}</td>
                <td>{{ task.progress }}%</td>
                <td>{{ formatSpeed(task.downloadSpeed) }}</td>
                <td>{{ formatSize(task.completedLength) }} / {{ formatSize(task.totalLength) }}</td>
                <td class="task-actions">
                  <button class="row-button" type="button" :disabled="taskActionGid === task.gid || !['active', 'paused'].includes(task.status)" @click="toggleDownloadTask(task)">
                    {{ task.status === 'paused' ? '继续' : '暂停' }}
                  </button>
                  <button class="ghost-button" type="button" :disabled="taskActionGid === task.gid" @click="requestDeleteDownloadTask(task)">删除</button>
                </td>
              </tr>
              <tr v-if="!downloadTasks.length"><td class="empty-cell" colspan="6">暂无下载任务</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <DownloadCenter />
    </main>

    <div v-if="downloadDialog" class="modal-mask" @click.self="downloadDialog = null">
      <div class="modal">
        <div class="modal-header">
          <h3>下载链接</h3>
          <button class="icon-button" type="button" aria-label="关闭" @click="downloadDialog = null">x</button>
        </div>
        <p class="modal-file">{{ downloadDialog.name }}</p>
        <textarea v-if="downloadDialog.downloadUrl" readonly :value="downloadDialog.downloadUrl"></textarea>
        <div v-else class="proxy-download-note">该文件将通过本站代理或临时链接下载。</div>
        <p class="cache-note">过期时间：{{ new Date(downloadDialog.expiresAt).toLocaleString() }}</p>
        <div class="modal-actions">
          <button class="ghost-button" type="button" @click="downloadDialog = null">关闭</button>
          <button class="ghost-button" type="button" @click="startBrowserDownload">浏览器下载</button>
          <button v-if="downloadDialog.downloadUrl" class="ghost-button" type="button" @click="copyDownloadUrl">复制直链</button>
          <button v-if="downloadDialog.proxyUrl" class="ghost-button" type="button" @click="copyProxyDownloadUrl">复制代理地址</button>
          <button class="primary-button" type="button" @click="useBuiltInDownloader">用内置下载器下载</button>
        </div>
      </div>
    </div>

    <div v-if="deleteTaskDialog" class="modal-mask" @click.self="deleteTaskDialog = null">
      <div class="modal delete-modal">
        <div class="modal-header">
          <h3>删除下载任务</h3>
          <button class="icon-button" type="button" aria-label="关闭" @click="deleteTaskDialog = null">x</button>
        </div>
        <p class="modal-file">{{ deleteTaskDialog.fileName }}</p>
        <p class="delete-note">请选择删除方式。本地文件只会在确认后删除。</p>
        <div class="modal-actions">
          <button class="ghost-button" type="button" @click="deleteTaskDialog = null">取消</button>
          <button class="ghost-button" type="button" @click="confirmDeleteDownloadTask(false)">只删除记录</button>
          <button class="danger-button" type="button" @click="confirmDeleteDownloadTask(true)">删除记录并删除本地文件</button>
        </div>
      </div>
    </div>

    <div v-if="authDialog" class="modal-mask" @click.self="closeAuthDialog">
      <div class="modal auth-modal">
        <div class="modal-header">
          <h3>夸克扫码登录</h3>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeAuthDialog">x</button>
        </div>
        <div class="qr-box">
          <img :src="authDialog.qrImageUrl" alt="夸克扫码登录二维码" />
          <p class="path-text">此二维码仅用于夸克账号登录，不是 B 站登录。</p>
          <p>{{ authStatus?.message || '等待扫码确认' }}</p>
          <a :href="authDialog.qrLoginUrl" target="_blank" rel="noreferrer">打开登录链接</a>
        </div>
        <div class="modal-actions">
          <button class="ghost-button" type="button" @click="startQrLogin">刷新二维码</button>
          <button class="primary-button" type="button" @click="pollQrLoginStatus">检查状态</button>
        </div>
      </div>
    </div>
  </div>
</template>
