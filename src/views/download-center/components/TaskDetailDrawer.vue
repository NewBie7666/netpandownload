<script setup lang="ts">
import type { ProductUiTask } from '../../../api/product'

defineProps<{
  task: ProductUiTask | null
}>()

const emit = defineEmits<{
  close: []
}>()

function providerLabel(providerId: ProductUiTask['providerId']) {
  if (providerId === 'quark') return '夸克'
  if (providerId === 'bilibili') return 'B站'
  return '未知来源'
}

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

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString() : '未提供'
}
</script>

<template>
  <div v-if="task" class="dc-drawer-mask" @click.self="emit('close')">
    <aside class="dc-drawer">
      <div class="dc-drawer-header">
        <div>
          <h3>任务详情</h3>
          <p>{{ task.title }}</p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">x</button>
      </div>

      <dl class="dc-detail-list">
        <div>
          <dt>状态</dt>
          <dd>{{ statusLabel(task.status) }}</dd>
        </div>
        <div>
          <dt>进度</dt>
          <dd>{{ task.progress }}%</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{{ providerLabel(task.providerId) }}</dd>
        </div>
        <div>
          <dt>错误</dt>
          <dd v-if="task.error">
            <strong>{{ task.error.title }}</strong>
            <span>{{ task.error.message }}</span>
            <small v-if="task.error.actionHint">{{ task.error.actionHint }}</small>
          </dd>
          <dd v-else>未提供</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{{ formatDate(task.createdAt) }}</dd>
        </div>
      </dl>
    </aside>
  </div>
</template>
