<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  fetchProductDashboard,
  fetchProductHistoryViews,
  fetchProductTaskViews,
  type ProductHealth,
  type ProductUiTask
} from '../../api/product'
import DashboardCard from './components/DashboardCard.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import TaskDetailDrawer from './components/TaskDetailDrawer.vue'
import TaskList from './components/TaskList.vue'

type TaskFilter = 'all' | 'active' | 'waiting' | 'success' | 'failed'
type BilibiliLoginMode = 'anonymous' | 'cookie'

interface DesktopApiForDownloadCenter {
  getBilibiliLoginStatus?: () => Promise<{
    loggedIn: boolean
    cookieValid: boolean
    lastLoginTime?: number
    mode: BilibiliLoginMode
  }>
}

const filterItems: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '下载中' },
  { value: 'waiting', label: '等待中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' }
]

const tasks = ref<ProductUiTask[]>([])
const history = ref<ProductUiTask[]>([])
const selectedTaskId = ref('')
const selectedTask = computed(() => tasks.value.find(task => task.id === selectedTaskId.value) || null)
const filter = ref<TaskFilter>('all')
const search = ref('')
const showTaskOverview = ref(false)
const showClearHistoryConfirm = ref(false)
const historyNotice = ref('')
const historyClearError = ref('')

// The server does not expose a history-deletion endpoint. Keep this action
// strictly presentational and persistent per client, without touching downloads.
const HIDDEN_HISTORY_STORAGE_KEY = 'netpandownload-hidden-history-v1'
const hiddenHistoryIds = ref<string[]>([])
const visibleHistory = computed(() => {
  const hidden = new Set(hiddenHistoryIds.value)
  return history.value.filter(item => !hidden.has(item.id))
})

function restoreHiddenHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HIDDEN_HISTORY_STORAGE_KEY) || '[]') as unknown
    if (Array.isArray(stored)) {
      hiddenHistoryIds.value = stored.filter((id): id is string => typeof id === 'string')
    }
  } catch {
    // A damaged or unavailable local preference must not affect task retrieval.
    hiddenHistoryIds.value = []
  }
}

function clearVisibleHistory() {
  historyClearError.value = ''
  const ids = [...new Set([...hiddenHistoryIds.value, ...visibleHistory.value.map(item => item.id)])].slice(-2000)
  try {
    window.localStorage.setItem(HIDDEN_HISTORY_STORAGE_KEY, JSON.stringify(ids))
    hiddenHistoryIds.value = ids
    showClearHistoryConfirm.value = false
    historyNotice.value = '已从当前设备的界面清除历史显示；下载文件和服务端历史存档均未删除。'
  } catch {
    historyClearError.value = '无法保存清除状态。请检查当前应用的本地存储权限。'
  }
}
const message = ref('')
const bilibiliCookieStatus = ref<'anonymous' | 'logged_in' | 'expired'>('anonymous')

let pollTimer: number | undefined

const waitingCount = computed(() => tasks.value.filter((task) => task.status === 'waiting').length)
const activeCount = computed(() => tasks.value.filter((task) => task.status === 'active').length)
const successCount = computed(() => tasks.value.filter((task) => task.status === 'success').length)
const failedCount = computed(() => tasks.value.filter((task) => task.status === 'failed').length)

const health = computed<ProductHealth>(() => {
  const values = tasks.value.map((task) => task.health).filter(Boolean) as ProductHealth[]
  if (values.includes('unstable')) return 'unstable'
  if (values.includes('degraded')) return 'degraded'
  return 'stable'
})

const healthText = computed(() => {
  if (health.value === 'unstable') return '下载健康：不稳定'
  if (health.value === 'degraded') return '下载健康：降级'
  return '下载健康：稳定'
})

const bilibiliCookieStatusText = computed(() => {
  if (bilibiliCookieStatus.value === 'logged_in') return 'B站登录状态：已登录'
  if (bilibiliCookieStatus.value === 'expired') return 'B站登录状态：可能已失效'
  return 'B站登录状态：匿名模式'
})

const filteredTasks = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return tasks.value.filter((task) => {
    if (filter.value !== 'all' && task.status !== filter.value) return false
    if (!keyword) return true
    return task.title.toLowerCase().includes(keyword)
  })
})

async function refreshBilibiliCookieStatus() {
  const desktopApi = (window as Window & { desktopApi?: DesktopApiForDownloadCenter }).desktopApi
  if (!desktopApi?.getBilibiliLoginStatus) {
    bilibiliCookieStatus.value = 'anonymous'
    return
  }

  try {
    const status = await desktopApi.getBilibiliLoginStatus()
    bilibiliCookieStatus.value = status.loggedIn && status.cookieValid ? 'logged_in' : 'expired'
  } catch {
    bilibiliCookieStatus.value = 'anonymous'
  }
}

async function refreshDownloadCenter(silent = false) {
  try {
    const [, tasksResult, historyResult] = await Promise.all([
      fetchProductDashboard(),
      fetchProductTaskViews(),
      fetchProductHistoryViews(),
      refreshBilibiliCookieStatus()
    ])
    tasks.value = tasksResult.tasks
    history.value = historyResult.items
    message.value = ''
  } catch (error) {
    message.value = error instanceof Error ? error.message : '下载中心暂不可用'
    if (!silent) {
      tasks.value = []
      history.value = []
    }
  }
}

onMounted(() => {
  restoreHiddenHistory()
  void refreshDownloadCenter(true)
  pollTimer = window.setInterval(() => {
    void refreshDownloadCenter(true)
  }, 2000)
})

onBeforeUnmount(() => {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
})
</script>

<template>
  <section class="panel product-panel">
    <div class="table-header">
      <div>
        <h2>下载中心</h2>
        <p class="path-text">统一展示下载任务状态和历史结果</p>
        <p class="path-text">{{ bilibiliCookieStatusText }}</p>
      </div>
      <span class="dc-health-badge" :class="`is-${health}`">{{ healthText }}</span>
    </div>

    <div class="dc-dashboard-grid">
      <DashboardCard label="下载中" :value="activeCount" tone="blue" />
      <DashboardCard label="等待中" :value="waitingCount" tone="gray" />
      <DashboardCard label="成功" :value="successCount" tone="green" />
      <DashboardCard label="失败" :value="failedCount" tone="red" />
    </div>

    <div v-if="message" class="downloader-status">
      <p>{{ message }}</p>
    </div>

    <div class="dc-reveal-row">
      <button class="ghost-button" type="button" :aria-expanded="showTaskOverview" @click="showTaskOverview = !showTaskOverview">
        {{ showTaskOverview ? '收起聚合任务列表' : '查看聚合任务列表' }}
      </button>
      <span class="path-text">当前任务的操作请使用上方「当前任务」页面。</span>
    </div>

    <div v-if="showTaskOverview" class="dc-section">
      <div class="dc-section-header">
        <div>
          <h3>聚合任务列表</h3>
          <p>按任务标题、状态和来源查看下载进度</p>
        </div>
        <div class="dc-tools">
          <input v-model="search" type="search" placeholder="搜索任务标题" />
          <div class="dc-filter">
            <button
              v-for="item in filterItems"
              :key="item.value"
              type="button"
              :class="{ active: filter === item.value }"
              @click="filter = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>
      <TaskList :tasks="filteredTasks" @select="selectedTaskId = $event.id" />
    </div>

    <div class="dc-section">
      <div class="dc-section-header">
        <div>
          <h3>历史记录</h3>
          <p>仅显示已结束的任务；清除仅影响当前设备的显示</p>
        </div>
        <button class="ghost-button dc-clear-button" type="button"
          :disabled="!visibleHistory.length" @click="historyNotice = ''; historyClearError = ''; showClearHistoryConfirm = true">
          清除历史
        </button>
      </div>
      <div v-if="showClearHistoryConfirm" class="dc-clear-confirm" role="alertdialog"
        aria-labelledby="clear-history-title" aria-describedby="clear-history-description" aria-modal="false">
        <strong id="clear-history-title">清除 {{ visibleHistory.length }} 条历史显示？</strong>
        <p id="clear-history-description">此操作只隐藏本设备已显示的历史记录，刷新页面后仍有效。不会删除下载文件、服务端历史存档，也不会停止正在下载的任务。</p>
        <p v-if="historyClearError" class="message error" role="alert">{{ historyClearError }}</p>
        <div class="dc-clear-actions">
          <button class="ghost-button" type="button" @click="showClearHistoryConfirm = false">取消</button>
          <button class="danger-button" type="button" @click="clearVisibleHistory">确认清除显示</button>
        </div>
      </div>
      <p v-if="historyNotice" class="dc-history-notice" role="status">{{ historyNotice }}</p>
      <HistoryPanel :items="visibleHistory" />
    </div>

    <TaskDetailDrawer :task="selectedTask" @close="selectedTaskId = ''" />
  </section>
</template>

<style scoped>
.dc-health-badge {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
}

.dc-health-badge.is-stable {
  color: #047857;
  background: #d1fae5;
}

.dc-health-badge.is-degraded {
  color: #92400e;
  background: #fef3c7;
}

.dc-health-badge.is-unstable {
  color: #b91c1c;
  background: #fee2e2;
}
.dc-reveal-row {
  padding: 0 24px 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.dc-reveal-row .path-text { margin-top: 0; }
.dc-clear-button { align-self: center; }
.dc-clear-confirm {
  margin: 14px 24px;
  border: 1px solid #fecaca;
  background: #fffafa;
  border-radius: 10px;
  padding: 16px 18px;
  display: grid;
  gap: 10px;
}
.dc-clear-confirm strong { color: #991b1b; font-size: 14px; }
.dc-clear-confirm p { color: #475569; line-height: 1.5; font-size: 13px; }
.dc-clear-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dc-history-notice { margin: 12px 24px; font-size: 13px; color: #047857; }
@media (max-width: 640px) {
  .dc-reveal-row { padding: 0 16px 14px; }
  .dc-clear-confirm { margin: 12px 16px; }
}
</style>
