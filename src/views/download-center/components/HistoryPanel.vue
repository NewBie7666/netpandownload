<script setup lang="ts">
import type { ProductUiTask } from '../../../api/product'

defineProps<{
  items: ProductUiTask[]
}>()

function statusLabel(status: ProductUiTask['status']) {
  return status === 'success' ? '成功' : '失败'
}

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString() : '未提供'
}
</script>

<template>
  <div class="dc-history">
    <div v-for="item in items" :key="item.id" class="dc-history-item">
      <span class="dc-history-dot" :class="`is-${item.status}`"></span>
      <div>
        <p>{{ item.title }}</p>
        <small>{{ statusLabel(item.status) }} · {{ formatDate(item.createdAt) }}</small>
      </div>
    </div>
    <div v-if="!items.length" class="dc-empty">暂无历史记录</div>
  </div>
</template>

<style scoped>
.dc-history {
  gap: 8px;
}

.dc-history-dot.is-success {
  background: #10b981;
}

.dc-history-dot.is-failed {
  background: #ef4444;
}
</style>
