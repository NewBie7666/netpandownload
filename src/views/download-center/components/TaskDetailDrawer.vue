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
  if (providerId === 'bilibili') return 'Bilibili'
  return '未知'
}

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

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString() : '-'
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
          <dt>taskId</dt>
          <dd>{{ task.id }}</dd>
        </div>
        <div>
          <dt>providerId</dt>
          <dd>{{ providerLabel(task.providerId) }}</dd>
        </div>
        <div>
          <dt>source</dt>
          <dd>{{ task.source }}</dd>
        </div>
        <div>
          <dt>status</dt>
          <dd>{{ statusLabel(task.status) }} / {{ task.rawStatus }}</dd>
        </div>
        <div>
          <dt>progress</dt>
          <dd>{{ task.progress }}%</dd>
        </div>
        <div>
          <dt>sourceUrl</dt>
          <dd>{{ task.sourceUrl || '未提供' }}</dd>
        </div>
        <div>
          <dt>downloadUrl</dt>
          <dd>{{ task.downloadUrl || '未提供' }}</dd>
        </div>
        <div>
          <dt>gid</dt>
          <dd>{{ task.gid || '未提供' }}</dd>
        </div>
        <div>
          <dt>error</dt>
          <dd v-if="task.error">
            {{ task.error.message }}（{{ task.error.code }}，{{ task.error.recoverable ? '可恢复' : '不可恢复' }}）
          </dd>
          <dd v-else>无</dd>
        </div>
        <div>
          <dt>createdAt</dt>
          <dd>{{ formatDate(task.createdAt) }}</dd>
        </div>
      </dl>
    </aside>
  </div>
</template>
