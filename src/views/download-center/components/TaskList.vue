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
    active: '下载中',
    paused: '已暂停',
    success: '成功',
    failed: '失败'
  }
  return labels[status]
}

function providerLabel(providerId: ProductUiTask['providerId']) {
  if (providerId === 'quark') return '夸克'
  if (providerId === 'bilibili') return 'B站'
  return '未知来源'
}

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString() : '未提供'
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
          <p class="dc-task-meta">{{ providerLabel(task.providerId) }} · {{ formatDate(task.createdAt) }}</p>
        </div>
        <span class="dc-status-badge" :class="`is-${task.status}`">{{ statusLabel(task.status) }}</span>
      </div>

      <div v-if="task.progress > 0" class="dc-progress">
        <span :style="{ width: `${task.progress}%` }"></span>
      </div>
      <p v-if="task.error" class="dc-task-error">
        <strong>{{ task.error.title }}</strong>
        {{ task.error.message }}
        <span v-if="task.error.actionHint" class="dc-action-hint">{{ task.error.actionHint }}</span>
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
  min-height: 88px;
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

.dc-action-hint {
  display: inline-flex;
  margin-left: 8px;
  color: #475569;
  font-weight: 600;
}
</style>
