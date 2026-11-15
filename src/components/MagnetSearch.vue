<script setup lang="ts">
import { ref } from 'vue'
import { addDownloadTask } from '../api/downloads'

interface MagnetCandidate {
  hash: string
  title: string
  size: string
  magnet: string
  isHD: boolean
  hasSubtitle: boolean
}
interface MagnetResult {
  code: string
  source: string
  items: MagnetCandidate[]
}
const code = ref('')
const searching = ref(false)
const downloading = ref('')
const searched = ref(false)
const result = ref<MagnetResult | null>(null)
const message = ref('')
const error = ref('')

async function search() {
  if (searching.value) return
  error.value = ''
  message.value = ''
  searched.value = false
  result.value = null
  searching.value = true
  try {
    const response = await fetch('/api/magnets/search?code=' + encodeURIComponent(code.value.trim()))
    const body = await response.json()
    if (!response.ok || !body.ok) throw new Error(body.message || '搜索失败')
    result.value = body.result as MagnetResult
    searched.value = true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '搜索失败'
  } finally {
    searching.value = false
  }
}

async function download(item: MagnetCandidate) {
  if (downloading.value) return
  error.value = ''
  message.value = ''
  downloading.value = item.hash
  try {
    const added = await addDownloadTask({ url: item.magnet, fileName: item.title })
    message.value = added.duplicate ? '相同 BT 资源已有任务，未重复下载。' : '已加入 BT 下载器：正在发现节点及获取元数据；可在下载中心查看连接数和进度。'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '下载任务创建失败'
  } finally {
    downloading.value = ''
  }
}

async function copyMagnet(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    message.value = '磁力链接已复制'
  } catch {
    error.value = '复制失败，请检查剪贴板权限'
  }
}
</script>

<template>
  <section class="panel parser-panel magnet-panel">
    <h2>番号 / 磁力搜索</h2>
    <p class="magnet-help">桌面版功能：输入番号获取可用磁力候选，通过内置 aria2 下载。仅下载有合法授权的资源。</p>
    <form class="magnet-form" @submit.prevent="search">
      <label for="magnet-code">番号</label>
      <input id="magnet-code" v-model="code" maxlength="32" autocomplete="off" placeholder="例如 ABP-123" :disabled="searching" />
      <button class="primary-button" :disabled="searching || !code.trim()" type="submit">{{ searching ? '搜索中…' : '搜索磁力' }}</button>
    </form>
    <p v-if="error" class="magnet-error" role="alert">{{ error }}</p>
    <p v-if="message" class="magnet-success" role="status">{{ message }}</p>
    <p v-if="searched && result && !result.items.length">没有找到磁力资源，或搜索源尚未收录该番号。</p>
    <div v-if="result?.items.length" class="magnet-results">
      <p>找到 {{ result.items.length }} 个结果 · 来源：{{ result.source }}（资源可用性取决于实际做种情况）</p>
      <div v-for="item in result.items" :key="item.hash" class="magnet-result">
        <div class="magnet-result-info">
          <strong>{{ item.title }}</strong>
          <small>{{ item.size || '大小未知' }} <span v-if="item.isHD"> · 高清</span><span v-if="item.hasSubtitle"> · 字幕</span></small>
        </div>
        <div class="magnet-buttons">
          <button class="ghost-button" type="button" @click="copyMagnet(item.magnet)">复制磁力</button>
          <button class="primary-button" type="button" :disabled="Boolean(downloading)" @click="download(item)">{{ downloading === item.hash ? '添加中…' : '下载' }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.magnet-panel { margin-top: 22px; }
.magnet-panel h2 { margin: 0 0 12px; }
.magnet-help { color: #64748b; line-height: 1.6; }
.magnet-form { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 20px 0; }
.magnet-form input { flex: 1 1 240px; min-width: 0; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; }
.magnet-results { margin-top: 16px; }
.magnet-result { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 12px; border-top: 1px solid #e2e8f0; flex-wrap: wrap; }
.magnet-result-info { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.magnet-result-info small { color: #64748b; }
.magnet-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.magnet-error { color: #b91c1c; }
.magnet-success { color: #047857; }
</style>
