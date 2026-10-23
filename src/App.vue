<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  addDownloadTask as addDownloaderTask,
  addDirectDownloadTask,
  scanPageForFiles,
  fetchDownloadTasks,
  openDownloadDir,
  pauseDownloadTask,
  removeDownloadTask,
  resumeDownloadTask,
  saveDownloadSettings
} from './api/downloads'
import { resolveDownloadDecision } from './api/decision'
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
import { chooseVisibleFiles, dropVisibleFiles, filterFileLinks, getFileSelectionState, groupFileExtensions, setFileTypeSelected, submitPageDownloadBatch, PAGE_BATCH_LIMIT } from './api/pageFileSelection'
import type {
  DownloadResult,
  DownloadDecision,
  DownloadTask,
  DownloadTasksResult,
  PageFileLink,
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
      openPageScanBrowser?: (url: string) => Promise<{ pageUrl: string }>
      scanInteractivePage?: (extensions: string) => Promise<{ pageUrl: string, extensions: string[], items: PageFileLink[], truncated: boolean, domCandidates?: number, networkCandidates?: number }>
      loginBilibili?: () => Promise<BilibiliLoginResult>
      getBilibiliLoginStatus?: () => Promise<BilibiliLoginStatus>
      logoutBilibili?: () => Promise<BilibiliLoginStatus>
    }
  }
}

const pageScanUrl = ref('')
const pageScanExtensions = ref('')
const pageScanLoading = ref(false)
const pageBatchLoading = ref(false)
const pageBatchCompleted = ref(0)
const pageBatchTotal = ref(0)
const pageScanLinks = ref<PageFileLink[]>([])
const pageScanSelected = ref<string[]>([])
const pageVisibleType = ref('')
const pageScanTruncated = ref(false)
const pageScanMessage = ref('')
const pageScanError = ref('')
const pageBatchLimit = PAGE_BATCH_LIMIT
const pageTypeGroups = computed(() => groupFileExtensions(pageScanLinks.value).map(group => ({
  ...group,
  ...getFileSelectionState(pageScanSelected.value, filterFileLinks(pageScanLinks.value, [group.extension]))
})))
const visiblePageLinks = computed(() => pageVisibleType.value
  ? filterFileLinks(pageScanLinks.value, [pageVisibleType.value]) : pageScanLinks.value)
const selectedPageLinks = computed(() => pageScanLinks.value.filter((item) => pageScanSelected.value.includes(item.url)))
const hiddenPageSelectionCount = computed(() => selectedPageLinks.value.filter((item) => !visiblePageLinks.value.includes(item)).length)
const nextPageBatchCount = computed(() => Math.min(selectedPageLinks.value.length, pageBatchLimit))
const visibleSelectedCount = computed(() => visiblePageLinks.value.filter((item) => pageScanSelected.value.includes(item.url)).length)
const directDownloadUrl = ref('')
const directDownloadFileName = ref('')
const directDownloadLoading = ref(false)
const shareUrl = ref('')
const privateWeb = ref(false)
const desktopAvailable = Boolean(window.desktopApi?.selectDownloadDir)
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
const decisionLoading = ref(false)
const downloadDecision = ref<DownloadDecision | null>(null)
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
const mediaFilter = ref<'all' | 'image' | 'video'>('all')
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
const visibleFiles = computed(() => {
  if (currentProviderId.value !== 'instagram' || mediaFilter.value === 'all') return files.value
  return files.value.filter((file) => mediaFilter.value === 'image'
    ? /\.(jpg|jpeg|png|webp|gif)$/i.test(file.name)
    : /\.(mp4|mov|webm)$/i.test(file.name))
})
const visibleSelectableFiles = computed(() => visibleFiles.value.filter((file) => !file.isDir))
const selectedFiles = computed(() => selectableFiles.value.filter((file) => selectedFileIds.value.includes(file.fid)))
const allSelectableSelected = computed(
  () => visibleSelectableFiles.value.length > 0 && visibleSelectableFiles.value.every((file) => selectedFileIds.value.includes(file.fid))
)
const batchDownloadProgressText = computed(() => {
  if (!batchDownloadLoading.value || !batchDownloadTotal.value) return ''
  return `正在加入下载任务：${batchDownloadDone.value} / ${batchDownloadTotal.value}`
})

const decisionPlatformText = computed(() => {
  const platform = downloadDecision.value?.platform
  const labels: Record<DownloadDecision['platform'], string> = {
    bilibili: 'B站',
    quark: '夸克',
    youtube: 'YouTube',
    douyin: '抖音',
    zhihu: '知乎',
    instagram: 'Instagram',
    unknown: '未知来源'
  }
  return platform ? labels[platform] : ''
})

const decisionRiskText = computed(() => {
  const risk = downloadDecision.value?.riskLevel
  if (risk === 'low') return '低'
  if (risk === 'medium') return '中'
  if (risk === 'high') return '高'
  return ''
})

const decisionToolText = computed(() => {
  const tool = downloadDecision.value?.recommendedTool
  if (!tool) return ''
  if (tool.name === 'desktop-downloader' && tool.capability === 'video-extract') return '桌面端视频解析下载能力'
  if (tool.name === 'desktop-downloader' && tool.capability === 'multi-thread-download') return '桌面端内置多线程下载器'
  if (tool.name === 'external-downloader') return '本机外部下载工具'
  if (tool.name === 'browser') return '浏览器'
  return '暂不支持'
})

const decisionActionText = computed(() => {
  const action = downloadDecision.value?.action
  if (action === 'use_desktop_downloader') return '继续使用当前桌面端处理'
  if (action === 'use_local_tool') return '使用本机工具处理'
  if (action === 'copy_url') return '复制链接到本机工具'
  return '当前版本暂不支持执行'
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
  const ids = new Set(selectedFileIds.value)
  for (const file of visibleSelectableFiles.value) {
    if (allSelectableSelected.value) ids.delete(file.fid)
    else ids.add(file.fid)
  }
  selectedFileIds.value = [...ids]
}

function normalizeResourceUrlInput(value: string) {
  const trimmed = String(value || '').trim().replace(/^["']|["']$/g, '')
  if (!trimmed) return ''

  if (/^pan\.quark\.cn\/s\//i.test(trimmed)) {
    return `https://${trimmed}`
  }
  if (/^(www\.)?instagram\.com\//i.test(trimmed)) return `https://${trimmed}`
  if (/^(www\.)?bilibili\.com\//i.test(trimmed) || /^space\.bilibili\.com\//i.test(trimmed) || /^b23\.tv\//i.test(trimmed)) {
    return `https://${trimmed}`
  }

  const matched = trimmed.match(/https?:\/\/pan\.quark\.cn\/s\/[^\s"'<>]+/i)
    || trimmed.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i)
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
    if (/^(?:www\.|m\.)?instagram\.com$/i.test(url.hostname)) {
      return /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
        ? '' : '只支持 Instagram 单个 /p/、/reel/ 或 /tv/ 帖子'
    }
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

async function refreshDownloadDecision(url: string) {
  const normalized = normalizeResourceUrlInput(url)
  if (!normalized) {
    downloadDecision.value = null
    return
  }

  decisionLoading.value = true
  try {
    downloadDecision.value = await resolveDownloadDecision(normalized)
  } catch {
    downloadDecision.value = null
  } finally {
    decisionLoading.value = false
  }
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
  const normalizedShareUrl = normalizeResourceUrlInput(shareUrl.value)
  void refreshDownloadDecision(normalizedShareUrl)
  const validation = validateResourceUrl(shareUrl.value)
  if (validation) {
    errorMessage.value = validation
    return
  }

  loading.value = true
  try {
    shareUrl.value = normalizedShareUrl
    const result = await resolveProviderResource(normalizedShareUrl, passcode.value.trim(), authSessionId.value)
    currentProviderId.value = result.providerId
    shareId.value = result.share.shareId
    stoken.value = result.share.stoken
    files.value = result.share.files
    clearFileSelection()
    mediaFilter.value = 'all'
    pathStack.value = []
    noticeMessage.value = `已通过 ${result.providerId === 'quark' ? '夸克' : result.providerId === 'instagram' ? 'Instagram' : 'Bilibili'} 获取 ${result.share.files.length} 个文件`
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

async function openInteractivePage() {
  pageScanError.value = ''
  pageScanMessage.value = ''
  if (!window.desktopApi?.openPageScanBrowser) {
    pageScanError.value = '该功能需要 Electron 桌面端'
    return
  }
  try {
    await window.desktopApi.openPageScanBrowser(pageScanUrl.value.trim())
    pageScanMessage.value = '已打开网页。请在新窗口点击补丁详情/分享，随后返回主窗口点击“扫描已打开页面”。'
  } catch (error) {
    pageScanError.value = error instanceof Error ? error.message : '无法打开交互式网页'
  }
}

async function scanInteractiveBrowser() {
  if (pageScanLoading.value || pageBatchLoading.value) return
  pageScanLoading.value = true
  pageScanError.value = ''
  pageScanMessage.value = ''
  pageScanLinks.value = []
  pageScanSelected.value = []
  pageVisibleType.value = ''
  pageScanTruncated.value = false
  try {
    if (!window.desktopApi?.scanInteractivePage) throw new Error('该功能需要 Electron 桌面端')
    const result = await window.desktopApi.scanInteractivePage(pageScanExtensions.value.trim())
    pageScanLinks.value = result.items
    pageScanTruncated.value = result.truncated
    pageScanMessage.value = result.items.length > 0
      ? '交互式扫描：找到 ' + result.items.length + ' 条匹配链接，请核对并勾选。'
      : '交互式扫描：0 条匹配链接（DOM 候选 ' + (result.domCandidates ?? 0) + '，网页请求候选 ' + (result.networkCandidates ?? 0) + '）。请在交互窗口展开补丁详情、点击真正的 JSON / SC / 下载链接后再扫描。'
  } catch (error) {
    pageScanError.value = error instanceof Error ? error.message : '交互式扫描失败'
  } finally {
    pageScanLoading.value = false
  }
}

async function submitPageScan() {
  if (pageScanLoading.value || pageBatchLoading.value) return
  pageScanLoading.value = true
  pageScanError.value = ''
  pageScanMessage.value = ''
  pageScanLinks.value = []
  pageScanSelected.value = []
  pageVisibleType.value = ''
  pageScanTruncated.value = false
  try {
    const result = await scanPageForFiles({
      url: pageScanUrl.value.trim(),
      extensions: pageScanExtensions.value.trim()
    })
    pageScanLinks.value = result.items
    pageScanTruncated.value = result.truncated
    pageScanMessage.value = '静态 HTML 扫描：找到 ' + result.items.length + ' 条匹配链接。' + (result.items.length ? '勾选后再下载。' : '如果网页通过弹窗加载文件链接，请改用交互式扫描。')
  } catch (error) {
    pageScanError.value = error instanceof Error ? error.message : '网页扫描失败'
  } finally {
    pageScanLoading.value = false
  }
}

function togglePageType(extension: string, checked: boolean) {
  if (pageBatchLoading.value) return
  pageScanSelected.value = setFileTypeSelected(pageScanSelected.value, pageScanLinks.value, extension, checked)
}

function selectAllPageLinks() {
  if (pageBatchLoading.value) return
  const visible = visiblePageLinks.value
  if (visible.length && visible.every((item) => pageScanSelected.value.includes(item.url))) {
    pageScanSelected.value = dropVisibleFiles(pageScanSelected.value, visible)
  } else {
    pageScanSelected.value = chooseVisibleFiles(pageScanSelected.value, visible)
  }
}

function clearPageFileSelection() {
  if (!pageBatchLoading.value) pageScanSelected.value = []
}

function togglePageLink(url: string) {
  if (pageBatchLoading.value) return
  if (pageScanSelected.value.includes(url)) {
    pageScanSelected.value = pageScanSelected.value.filter((item) => item !== url)
  } else {
    pageScanSelected.value = [...pageScanSelected.value, url]
  }
}

async function submitPageDownloads() {
  if (pageScanLoading.value || pageBatchLoading.value || !selectedPageLinks.value.length || !downloaderEnabled.value) return
  const items = [...selectedPageLinks.value]
  pageBatchLoading.value = true
  pageBatchCompleted.value = 0
  pageBatchTotal.value = Math.min(items.length, pageBatchLimit)
  pageScanError.value = ''
  pageScanMessage.value = ''
  try {
    const result = await submitPageDownloadBatch(items, addDirectDownloadTask, count => { pageBatchCompleted.value = count })
    pageScanSelected.value = result.remaining.map(link => link.url)
    pageScanMessage.value = '本次提交 ' + result.attemptedCount + ' 个：已加入 aria2 ' + result.completed.length
      + ' 个，失败 ' + result.failures.length + ' 个，未提交 ' + result.unattemptedCount + ' 个。'
      + (result.remaining.length ? '剩余 ' + result.remaining.length + ' 个仍勾选，请核对后再次点击下载。' : '')
    if (result.failures.length) pageScanError.value = result.failures.slice(0, 3)
      .map(({ link, message }) => link.fileName + '：' + message).join('；')
      + (result.failures.length > 3 ? '（还有更多失败项）' : '')
    await refreshDownloadTasks(true)
  } finally {
    pageBatchLoading.value = false
  }
}

async function submitDirectDownload() {
  if (directDownloadLoading.value) return
  clearMessages()
  directDownloadLoading.value = true
  try {
    const { gid } = await addDirectDownloadTask({
      url: directDownloadUrl.value,
      fileName: directDownloadFileName.value.trim() || undefined
    })
    noticeMessage.value = `已添加 HTTP 下载任务：${gid}`
    directDownloadUrl.value = ''
    directDownloadFileName.value = ''
    await refreshDownloadTasks(true)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '添加 HTTP 下载任务失败'
  } finally {
    directDownloadLoading.value = false
  }
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
    noticeMessage.value = task.status === 'paused' ? '已继续下载任务' : '已暂停下载任务'
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
    active: '下载中',
    waiting: '排队中',
    paused: '已暂停',
    error: '失败',
    complete: '已完成',
    removed: '已移除'
  }
  return labels[status] || status
}

onMounted(() => {
  void fetch('/api/health').then(r => r.json()).then(r => { privateWeb.value = r.result?.privateWeb === true }).catch(() => {})
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
          <input id="share-url" v-model="shareUrl" type="text" placeholder="夸克、B站或 Instagram 单帖链接" :disabled="loading" />
        </div>
        <div class="form-row">
          <label for="passcode">提取码</label>
          <input id="passcode" v-model="passcode" type="text" placeholder="仅夸克需要提取码" :disabled="loading" />
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
        <div v-if="decisionLoading || downloadDecision" class="decision-card">
          <div class="decision-main">
            <div>
              <p class="decision-kicker">下载决策</p>
              <h3>{{ decisionLoading && !downloadDecision ? '正在判断链接...' : decisionPlatformText }}</h3>
              <p v-if="downloadDecision" class="decision-text">{{ downloadDecision.explanation }}</p>
            </div>
            <span v-if="downloadDecision" class="decision-badge" :class="`risk-${downloadDecision.riskLevel}`">
              风险：{{ decisionRiskText }}
            </span>
          </div>
          <div v-if="downloadDecision" class="decision-grid">
            <div>
              <span>是否可处理</span>
              <strong>{{ downloadDecision.feasible ? '可处理' : '暂不支持' }}</strong>
            </div>
            <div>
              <span>推荐能力</span>
              <strong>{{ decisionToolText }}</strong>
            </div>
            <div>
              <span>下一步</span>
              <strong>{{ decisionActionText }}</strong>
            </div>
            <div>
              <span>置信度</span>
              <strong>{{ Math.round(downloadDecision.confidence * 100) }}%</strong>
            </div>
          </div>
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
            <label v-if="currentProviderId === 'instagram'" class="path-text">媒体筛选：<select v-model="mediaFilter" aria-label="筛选媒体类型"><option value="all">全部</option><option value="image">图片</option><option value="video">视频</option></select></label>
            <button class="ghost-button" type="button" :disabled="!visibleSelectableFiles.length || batchDownloadLoading" @click="toggleSelectAllFiles">
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
                <th><input type="checkbox" :checked="allSelectableSelected" :disabled="!visibleSelectableFiles.length || batchDownloadLoading" aria-label="全选当前列表文件" @change="toggleSelectAllFiles" /></th>
                <th>名称</th>
                <th>大小</th>
                <th>类型</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in visibleFiles" :key="file.fid">
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
              <tr v-if="!visibleFiles.length">
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
            <p class="path-text">{{ privateWeb ? '服务器临时下载目录' : '默认下载目录' }}：{{ downloaderDefaultDir || '-' }}</p>
            <p v-if="privateWeb" class="path-text">云端下载完成后，点击“保存到此设备”即可保存到手机或电脑。</p>
            <p v-if="downloaderMessage" class="path-text">{{ downloaderMessage }}</p>
          </div>
          <div class="task-header-actions">
            <button v-if="desktopAvailable" class="ghost-button" type="button" @click="selectDownloadDirectory">选择下载目录</button>
            <button v-if="desktopAvailable" class="ghost-button" type="button" @click="openDownloaderDir">打开下载目录</button>
            <button class="ghost-button" type="button" @click="refreshDownloadTasks(false)">刷新</button>
          </div>
        </div>
        <form class="direct-download-form" @submit.prevent="submitDirectDownload">
          <h3>HTTP/HTTPS 直链下载</h3>
          <p class="path-text">粘贴公开文件直链，直接交给 aria2 下载；不需要先解析网盘链接。</p>
          <div class="direct-download-fields">
            <label for="direct-download-url">文件链接</label>
            <input id="direct-download-url" v-model="directDownloadUrl" type="url" required
              placeholder="https://example.com/archive.zip" :disabled="directDownloadLoading || !downloaderEnabled" />
            <label for="direct-download-filename">保存文件名（可选）</label>
            <input id="direct-download-filename" v-model="directDownloadFileName" type="text"
              placeholder="留空则由下载服务器决定" :disabled="directDownloadLoading || !downloaderEnabled" />
          </div>
          <button class="primary-button" type="submit" :disabled="directDownloadLoading || !downloaderEnabled || !directDownloadUrl.trim()">
            {{ directDownloadLoading ? '添加中...' : '添加 HTTP 下载任务' }}
          </button>
        </form>

        <div class="page-scan-form">
          <h3>从网页筛选文件下载</h3>
          <p class="path-text">扫描后勾选类型可全选该类型文件，也可逐个调整。勾选不会开始下载，点击下载按钮后才提交到 aria2。</p>
          <form class="page-scan-fields" @submit.prevent="submitPageScan">
            <label for="page-scan-url">网页地址</label>
            <input id="page-scan-url" v-model="pageScanUrl" type="url" required placeholder="https://example.com/downloads/"
              :disabled="pageScanLoading || pageBatchLoading" />
            <label for="page-scan-ext">高级：扫描前限制后缀（可留空）</label>
            <input id="page-scan-ext" v-model="pageScanExtensions" type="text"
              placeholder="留空自动发现全部文件；可选 pkg,json" :disabled="pageScanLoading || pageBatchLoading" />
            <div class="page-scan-action">
              <button class="primary-button" type="submit" :disabled="pageScanLoading || pageBatchLoading">
                {{ pageScanLoading ? '正在扫描...' : '扫描 HTML（静态）' }}
              </button>
            </div>
          </form>
          <div class="page-scan-interactive-actions">
            <button class="ghost-button" type="button" :disabled="pageScanLoading || pageBatchLoading" @click="openInteractivePage">
              打开交互网页
            </button>
            <button class="ghost-button" type="button" :disabled="pageScanLoading || pageBatchLoading" @click="scanInteractiveBrowser">
              扫描已打开页面（交互）
            </button>
            <span class="path-text">适用于需要点击“详情/分享”后才显示链接的网站；先在弹出的网页里手动展开，再返回扫描。</span>
          </div>
          <p v-if="pageScanError" class="page-scan-error" role="alert">{{ pageScanError }}</p>
          <p v-if="pageScanMessage" class="page-scan-message" role="status">{{ pageScanMessage }}</p>
          <p v-if="pageScanTruncated" class="path-text">匹配项超过 200 条，仅展示前 200 条。</p>
          <div v-if="pageScanLinks.length" class="page-scan-results">
            <div class="page-type-filters" aria-label="按文件后缀选择">
              <div class="page-type-header">
                <strong>按类型勾选文件（部分选中显示横线）</strong>
                <label>显示类型
                  <select v-model="pageVisibleType" :disabled="pageBatchLoading">
                    <option value="">全部类型</option>
                    <option v-for="group in pageTypeGroups" :key="group.extension" :value="group.extension">
                      {{ group.extension === 'other' ? '其他/未知' : '.' + group.extension }} ({{ group.count }})
                    </option>
                  </select>
                </label>
              </div>
              <div class="page-type-options">
                <label v-for="group in pageTypeGroups" :key="group.extension" class="page-type-option">
                  <input type="checkbox" :checked="group.checked" :indeterminate="group.indeterminate"
                    :disabled="pageBatchLoading" @change="togglePageType(group.extension, ($event.target as HTMLInputElement).checked)" />
                  <span>{{ group.extension === 'other' ? '其他/未知' : '.' + group.extension }} ({{ group.count }})</span>
                </label>
              </div>
            </div>
            <div class="page-scan-toolbar">
              <span>显示 {{ visiblePageLinks.length }} / {{ pageScanLinks.length }}；已选 {{ selectedPageLinks.length }} 个（隐藏 {{ hiddenPageSelectionCount }}）；本次提交 {{ nextPageBatchCount }} 个，剩余 {{ selectedPageLinks.length - nextPageBatchCount }} 个需再次点击下载；每批最多 {{ pageBatchLimit }} 个</span>
              <div class="page-scan-toolbar-actions">
                <button class="ghost-button" type="button" :disabled="pageBatchLoading" @click="selectAllPageLinks">
                  {{ visiblePageLinks.length && visibleSelectedCount === visiblePageLinks.length ? '取消选择当前筛选' : '选择当前筛选' }}
                </button>
                <button class="ghost-button" type="button" :disabled="pageBatchLoading || !pageScanSelected.length" @click="clearPageFileSelection">清空已选</button>
                <button class="primary-button" type="button"
                  :disabled="pageBatchLoading || !downloaderEnabled || !selectedPageLinks.length"
                  @click="submitPageDownloads">
                  {{ pageBatchLoading ? '提交中 ' + pageBatchCompleted + '/' + pageBatchTotal : '下载本批 (' + nextPageBatchCount + '/' + selectedPageLinks.length + ')' }}
                </button>
              </div>
            </div>
            <div class="page-scan-list">
              <label v-for="link in visiblePageLinks" :key="link.url" class="page-scan-item">
                <input type="checkbox" :checked="pageScanSelected.includes(link.url)"
                  :disabled="pageBatchLoading"
                  @change="togglePageLink(link.url)" />
                <span class="page-scan-link-text">
                  <strong>{{ link.fileName }}</strong>
                  <small :title="link.url">{{ link.url }}</small>
                </span>
                <span class="page-scan-extension">{{ link.extension === 'other' ? '其他/未知' : '.' + link.extension }}</span>
              </label>
            </div>
            <p v-if="!visiblePageLinks.length" class="path-text">当前筛选没有显示文件，请调整“显示类型”。</p>
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
                  <button class="row-button" type="button" v-if="['active', 'waiting', 'paused'].includes(task.status)" :disabled="taskActionGid === task.gid" @click="toggleDownloadTask(task)">
                    {{ taskActionGid === task.gid ? '处理中...' : task.status === 'paused' ? '继续' : '暂停' }}
                  </button>
                  <a v-if="task.status === 'complete'" class="row-button file-save-link" :href="`/api/downloads/file/${encodeURIComponent(task.gid)}`" :download="task.fileName">保存到此设备</a>
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
          <button v-if="!privateWeb" class="ghost-button" type="button" @click="startBrowserDownload">浏览器下载</button>
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
