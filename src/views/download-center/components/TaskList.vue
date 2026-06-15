<script setup lang="ts">
import type { ProductUiTask } from '../../../api/product'

defineProps<{
  tasks: ProductUiTask[]
}>()

const emit = defineEmits<{
  select: [task: ProductUiTask]
}>()

function statusLabel(status: ProductUiTask['status']) {
  const labels: Record<ProductUiTask['status'], string> = {
    waiting: '等待中',
    active: '进行中',
    paused: '已暂停',
    success: '已完成',
    failed: '失败'
  }
  return labels[status] || status
}

function providerLabel(providerId: ProductUiTask['providerId']) {
  if (providerId === 'quark') return '夸克'
  if (providerId === 'bilibili') return 'Bilibili'
  return '未知'
}

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString() : '-'
}
</script>

<template>
  <div class="dc-task-list">
    <button
      v-for="task in tasks"
      :key="task.id"
      class="dc-task-card"
      type="button"
      @click="emit('select', task)"
    >
      <div class="dc-task-main">
        <div>
          <p class="dc-task-title">{{ task.title }}</p>
          <p class="dc-task-meta">
            {{ providerLabel(task.providerId) }} · {{ task.source === 'engine' ? 'Engine' : 'aria2' }} ·
            {{ formatDate(task.createdAt) }}
          </p>
        </div>
        <span class="dc-status-badge" :class="`is-${task.status}`">{{ statusLabel(task.status) }}</span>
      </div>

      <div v-if="task.progress > 0" class="dc-progress">
        <span :style="{ width: `${task.progress}%` }"></span>
      </div>
      <p v-if="task.error" class="dc-task-error">
        {{ task.error.message }}
        <span v-if="task.error.recoverable" class="dc-retry-label">Retry</span>
      </p>
    </button>

    <div v-if="!tasks.length" class="dc-empty">暂无匹配任务</div>
  </div>
</template>

<style scoped>
.dc-task-list {
  gap: 8px;
}

.dc-task-card {
  min-height: 92px;
}

.dc-status-badge.is-active {
  color: #1d4ed8;
  background: #dbeafe;
}

.dc-status-badge.is-waiting {
  color: #475569;
  background: #e2e8f0;
}

.dc-status-badge.is-success {
  color: #047857;
  background: #d1fae5;
}

.dc-status-badge.is-failed {
  color: #b91c1c;
  background: #fee2e2;
}

.dc-status-badge.is-paused {
  color: #92400e;
  background: #fef3c7;
}

.dc-retry-label {
  display: inline-flex;
  margin-left: 8px;
  padding: 2px 6px;
  color: #047857;
  background: #d1fae5;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
</style>
