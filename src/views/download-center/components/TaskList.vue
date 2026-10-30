<script setup lang="ts">
import type { ProductUiTask } from '../../../api/product'
import { getAria2TaskAction } from './taskActions'

defineProps<{
  tasks: ProductUiTask[]
  busyGid?: string
}>()

const emit = defineEmits<{
  select: [task: ProductUiTask]
  control: [task: ProductUiTask]
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
  return 'HTTP/aria2'
}

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString() : '未提供'
}
</script>

<template>
  <div class="dc-task-list">
    <div v-for="task in tasks" :key="task.id" class="dc-task-card">
      <button
        class="dc-task-overview"
        type="button"
        :aria-label="`查看任务详情：${task.title}`"
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
        <p v-if="task.presentedError" class="dc-task-error">
          <strong>{{ task.presentedError.title }}</strong>
          {{ task.presentedError.message }}
          <span v-if="task.presentedError.actionHint" class="dc-action-hint">{{ task.presentedError.actionHint }}</span>
        </p>
      </button>
      <div v-if="getAria2TaskAction(task)" class="dc-task-controls">
        <button
          class="row-button"
          type="button"
          :disabled="Boolean(busyGid)"
          :aria-label="`${task.status === 'paused' ? '继续' : '暂停'}任务：${task.title}`"
          @click="emit('control', task)"
        >
          {{ busyGid === task.gid ? '处理中...' : task.status === 'paused' ? '继续下载' : '暂停下载' }}
        </button>
      </div>
    </div>

    <div v-if="!tasks.length" class="dc-empty">暂无匹配任务</div>
  </div>
</template>

<style scoped>
.dc-task-card {
  min-height: 88px;
  cursor: default;
}

.dc-task-overview {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.dc-task-overview:focus-visible {
  outline: 2px solid #059669;
  outline-offset: 3px;
}

.dc-task-controls {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  margin-top: 8px;
  border-top: 1px solid #f1f5f9;
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
