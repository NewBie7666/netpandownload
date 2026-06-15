<script setup lang="ts">
defineProps<{
  label: string
  value: number
  tone?: 'blue' | 'gray' | 'green' | 'red' | 'yellow'
}>()
</script>

<template>
  <div class="dc-dashboard-card" :class="tone ? `is-${tone}` : ''">
    <span>{{ label }}</span>
    <strong>{{ value }}</strong>
  </div>
</template>
