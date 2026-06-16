<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  fetchProductDashboard,
  fetchProductHistoryViews,
  fetchProductTaskViews,
  type ProductUiTask
} from '../../api/product'
import DashboardCard from './components/DashboardCard.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import TaskDetailDrawer from './components/TaskDetailDrawer.vue'
import TaskList from './components/TaskList.vue'

type TaskFilter = 'all' | 'active' | 'waiting' | 'success' | 'failed'

const filterItems: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '下载中' },
  { value: 'waiting', label: '等待中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' }
]

const tasks = ref<ProductUiTask[]>([])
const history = ref<ProductUiTask[]>([])
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
    const [, tasksResult, historyResult] = await Promise.all([
      fetchProductDashboard(),
      fetchProductTaskViews(),
      fetchProductHistoryViews()
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
      </div>
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

    <div class="dc-section">
      <div class="dc-section-header">
        <div>
          <h3>任务列表</h3>
          <p>按任务标题、状态和来源快速查看下载进度</p>
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
          <p>只展示成功和失败的最终结果</p>
        </div>
      </div>
      <HistoryPanel :items="history" />
    </div>

    <TaskDetailDrawer :task="selectedTask" @close="selectedTask = null" />
  </section>
</template>
