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
  if (!trimmed) return '请输入夸克分享链接'

  try {
    const url = new URL(trimmed)
    if (!/pan\.quark\.cn$/i.test(url.hostname)) {
      return '仅支持夸克分享链接'
    }
    if (!/\/s\/[^/?#]+/.test(url.pathname)) {
      return '未识别到夸克分享 ID'
    }
  } catch {
    return '分享链接格式不正确'
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
    noticeMessage.value = `已获取 ${result.files.length} 个文件`
  } catch (error) {
    files.value = []
    pathStack.value = []
    errorMessage.value = error instanceof Error ? error.message : '获取文件列表失败'
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
    errorMessage.value = error instanceof Error ? error.message : '进入文件夹失败'
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
    errorMessage.value = error instanceof Error ? error.message : '返回上一级失败'
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
      fileName: downloadDialog.value.name
    })
    noticeMessage.value = '已加入下载任务'
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '添加下载任务失败'
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
      message: '等待扫码确认',
      expiresAt: result.expiresAt
    }
    authPollTimer = window.setInterval(pollQrLoginStatus, 2000)
    await pollQrLoginStatus()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建扫码登录失败'
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
  noticeMessage.value = '扫码登录状态已退出'
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

async function deleteDownloadTask(task: DownloadTask) {
  clearMessages()
  taskActionGid.value = task.gid
  try {
    await removeDownloadTask(task.gid)
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除下载任务失败'
  } finally {
    taskActionGid.value = ''
  }
}

async function openDownloaderDir() {
  clearMessages()
  try {
    const result = await openDownloadDir()
    noticeMessage.value = `下载目录：${result.dir}`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '打开下载目录失败'
  }
}

function formatTaskStatus(status: DownloadTask['status']) {
  const labels: Record<DownloadTask['status'], string> = {
    active: '下载中',
    waiting: '等待中',
    paused: '已暂停',
    error: '出错',
    complete: '已完成',
    removed: '已删除'
  }
  return labels[status] || status
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
      <section class="panel parser-panel">
        <div class="form-row">
          <label for="share-url">分享链接</label>
          <input
            id="share-url"
            v-model="shareUrl"
            type="text"
            placeholder="请输入夸克分享链接"
            :disabled="loading"
          />
        </div>
        <div class="form-row">
          <label for="passcode">提取码</label>
          <input
            id="passcode"
            v-model="passcode"
            type="text"
            placeholder="可不填；如需要请输入提取码"
            :disabled="loading"
          />
        </div>
        <div class="actions">
          <button class="primary-button" type="button" :disabled="loading" @click="loadShare">
            {{ loading ? '获取中...' : '获取文件列表' }}
          </button>
          <button
            v-if="!authSessionId"
            class="ghost-button"
            type="button"
            :disabled="authLoading"
            @click="startQrLogin"
          >
            {{ authLoading ? '二维码生成中...' : '扫码登录' }}
          </button>
          <button v-else class="ghost-button" type="button" @click="logoutQrLogin">
            已登录，退出
          </button>
        </div>
      </section>

      <p v-if="errorMessage" class="message error">{{ errorMessage }}</p>
      <p v-if="noticeMessage" class="message success">{{ noticeMessage }}</p>

      <section class="panel file-panel">
        <div class="table-header">
          <div>
            <h2>文件列表</h2>
            <p v-if="pathStack.length" class="path-text">
              / {{ pathStack.map((item) => item.name).join(' / ') }}
            </p>
          </div>
          <button class="ghost-button" type="button" :disabled="!canGoBack || loading" @click="goBack">
            返回上一级
          </button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>大小</th>
                <th>是否文件夹</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in files" :key="file.fid">
                <td>
                  <span class="file-name" :title="file.name">
                    <span class="file-icon">{{ file.isDir ? '文件夹' : '文件' }}</span>
                    {{ file.name }}
                  </span>
                </td>
                <td>{{ formatSize(file.size) }}</td>
                <td>{{ file.isDir ? '是' : '否' }}</td>
                <td>
                  <button
                    v-if="file.isDir"
                    class="row-button"
                    type="button"
                    :disabled="Boolean(folderLoadingFid)"
                    @click="enterFolder(file)"
                  >
                    {{ folderLoadingFid === file.fid ? '进入中...' : '进入文件夹' }}
                  </button>
                  <button
                    v-else
                    class="row-button"
                    type="button"
                    :disabled="Boolean(downloadLoadingFid)"
                    @click="openDownload(file)"
                  >
                    {{ downloadLoadingFid === file.fid ? '获取中...' : '获取链接' }}
                  </button>
                </td>
              </tr>
              <tr v-if="!loading && !hasFiles">
                <td class="empty-cell" colspan="4">
                  <div class="empty-state">
                    <div class="empty-icon">[]</div>
                    <p>暂无文件</p>
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
            <h2>下载任务</h2>
            <p class="path-text">内置下载器：{{ downloaderEnabled ? '可用' : '不可用' }}</p>
            <p class="path-text">默认下载目录：{{ downloaderDefaultDir || '正在读取下载目录...' }}</p>
          </div>
          <button class="ghost-button" type="button" @click="openDownloaderDir">打开下载目录</button>
        </div>

        <div v-if="!downloaderEnabled" class="downloader-status">
          <p>{{ downloaderMessage || '内置下载器不可用' }}</p>
          <p class="setup-command">powershell -ExecutionPolicy Bypass -File scripts/prepare-aria2.ps1</p>
        </div>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>文件名</th>
                <th>状态</th>
                <th>进度</th>
                <th>速度</th>
                <th>已下载</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in downloadTasks" :key="task.gid">
                <td>{{ task.fileName }}</td>
                <td>{{ formatTaskStatus(task.status) }}</td>
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
                    {{ task.status === 'paused' ? '继续' : '暂停' }}
                  </button>
                  <button
                    class="ghost-button"
                    type="button"
                    :disabled="taskActionGid === task.gid"
                    @click="deleteDownloadTask(task)"
                  >
                    删除
                  </button>
                </td>
              </tr>
              <tr v-if="!downloadTasks.length">
                <td class="empty-cell" colspan="6">
                  <div class="empty-state">
                    <div class="empty-icon">↓</div>
                    <p>暂无下载任务</p>
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
          <h3>下载链接</h3>
          <button class="icon-button" type="button" aria-label="关闭" @click="downloadDialog = null">
            x
          </button>
        </div>
        <p class="modal-file">{{ downloadDialog.name }}</p>
        <template v-if="downloadDialog.source === 'direct' && downloadDialog.downloadUrl">
          <textarea readonly :value="downloadDialog.downloadUrl"></textarea>
        </template>
        <template v-else>
          <div class="proxy-download-note">该文件将通过本站代理下载。</div>
        </template>
        <p class="cache-note">
          {{ downloadDialog.cached ? '已命中服务端缓存' : '已生成新链接' }}，
          过期时间：{{ new Date(downloadDialog.expiresAt).toLocaleString() }}
        </p>
        <div class="modal-actions">
          <button class="ghost-button" type="button" @click="downloadDialog = null">关闭</button>
          <button
            v-if="downloadDialog.source === 'direct'"
            class="ghost-button"
            type="button"
            @click="startBrowserDownload"
          >
            浏览器下载
          </button>
          <button
            v-if="downloadDialog.source === 'direct'"
            class="ghost-button"
            type="button"
            @click="copyDownloadUrl"
          >
            复制直链
          </button>
          <button
            v-if="downloadDialog.source !== 'direct'"
            class="ghost-button"
            type="button"
            @click="startBrowserDownload"
          >
            浏览器下载
          </button>
          <button
            v-if="downloadDialog.source !== 'direct'"
            class="ghost-button"
            type="button"
            @click="copyProxyDownloadUrl"
          >
            复制代理地址
          </button>
          <button class="primary-button" type="button" @click="useBuiltInDownloader">
            用内置下载器下载
          </button>
        </div>
      </div>
    </div>

    <div v-if="authDialog" class="modal-mask" @click.self="closeAuthDialog">
      <div class="modal auth-modal">
        <div class="modal-header">
          <h3>扫码登录</h3>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeAuthDialog">
            x
          </button>
        </div>
        <div class="qr-box">
          <img :src="authDialog.qrImageUrl" alt="夸克扫码登录二维码" />
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
