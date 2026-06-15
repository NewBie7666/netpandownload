<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  fetchProductDashboard,
  fetchProductHistoryViews,
  fetchProductTaskViews,
  type ProductUiTask
} from '../../api/product'
import type {
  DownloadDashboard,
} from '../../../shared/types'
import DashboardCard from './components/DashboardCard.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import TaskDetailDrawer from './components/TaskDetailDrawer.vue'
import TaskList from './components/TaskList.vue'

type TaskFilter = 'all' | 'active' | 'waiting' | 'success' | 'failed'

const filterItems: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'waiting', label: '等待中' },
  { value: 'success', label: '已完成' },
  { value: 'failed', label: '失败' }
]

const tasks = ref<ProductUiTask[]>([])
const history = ref<ProductUiTask[]>([])
const dashboard = ref<DownloadDashboard>({
  totalTasks: 0,
  runningCount: 0,
  pausedCount: 0,
  completedCount: 0,
  failedCount: 0,
  removedCount: 0,
  activeDownloads: 0
})
const selectedTask = ref<ProductUiTask | null>(null)
const filter = ref<TaskFilter>('all')
const search = ref('')
const message = ref('')

let pollTimer: number | undefined

const waitingCount = computed(() => tasks.value.filter((task) => task.status === 'waiting').length)
const activeCount = computed(() => tasks.value.filter((task) => task.status === 'active').length)
const successCount = computed(() => tasks.value.filter((task) => task.status === 'success').length)
const failedCount = computed(() => tasks.value.filter((task) => task.status === 'failed').length)

const filteredTasks = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return tasks.value.filter((task) => {
    if (filter.value !== 'all' && task.status !== filter.value) return false
    if (!keyword) return true
    return task.title.toLowerCase().includes(keyword)
  })
})

async function refreshDownloadCenter(silent = false) {
  try {
    const [dashboardResult, tasksResult, historyResult] = await Promise.all([
      fetchProductDashboard(),
      fetchProductTaskViews(),
      fetchProductHistoryViews()
    ])
    dashboard.value = dashboardResult
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
        <p class="path-text">统一展示执行任务、aria2 状态和历史记录</p>
      </div>
    </div>

    <div class="dc-dashboard-grid">
      <DashboardCard label="进行中" :value="activeCount" tone="blue" />
      <DashboardCard label="等待中" :value="waitingCount" tone="gray" />
      <DashboardCard label="已完成" :value="successCount" tone="green" />
      <DashboardCard label="失败" :value="failedCount" tone="red" />
      <DashboardCard label="活跃下载" :value="dashboard.activeDownloads" tone="yellow" />
    </div>

    <div v-if="message" class="downloader-status">
      <p>{{ message }}</p>
    </div>

    <div class="dc-section">
      <div class="dc-section-header">
        <div>
          <h3>任务列表</h3>
          <p>只读聚合视图，不控制下载执行</p>
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
      <TaskList :tasks="filteredTasks" @select="selectedTask = $event" />
    </div>

    <div class="dc-section">
      <div class="dc-section-header">
        <div>
          <h3>历史记录</h3>
          <p>仅展示已完成、失败和已移除任务</p>
        </div>
      </div>
      <HistoryPanel :items="history" />
    </div>

    <TaskDetailDrawer :task="selectedTask" @close="selectedTask = null" />
  </section>
</template>
