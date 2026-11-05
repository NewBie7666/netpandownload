<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { VideoItem, VideoSource } from '../../shared/videoSources'
import {
  addVideoSource, detailVideoSource, downloadVideoEpisode, importTvBoxConfig, importTvBoxUrl,
  listVideoSources, removeVideoSource, searchVideoSource,
  setVideoSourceEnabled, testVideoSource
} from '../api/videoSources'

const emit = defineEmits<{ (e: 'task-added'): void }>()
const sources = ref<VideoSource[]>([])
const selectedId = ref('')
const sourceName = ref('')
const sourceUrl = ref('')
const tvboxText = ref('')
const tvboxUrl = ref('')
const keyword = ref('')
const results = ref<VideoItem[]>([])
const detail = ref<VideoItem | null>(null)
const page = ref(1)
const pageCount = ref(1)
const loading = ref(false)
const changing = ref(false)
const downloading = ref('')
const message = ref('')
const error = ref('')

function resetMessages() { message.value = ''; error.value = '' }
function onSourceChanged() { results.value = []; detail.value = null; page.value = 1; resetMessages() }
async function refresh() {
  sources.value = await listVideoSources()
  if (!sources.value.some(source => source.id === selectedId.value && source.enabled)) {
    selectedId.value = sources.value.find(source => source.enabled)?.id || ''
    onSourceChanged()
  }
}
async function change(operation: () => Promise<void>) {
  if (changing.value) return
  changing.value = true
  resetMessages()
  try { await operation(); await refresh() }
  catch (e) { error.value = e instanceof Error ? e.message : '操作失败' }
  finally { changing.value = false }
}
function add() {
  void change(async () => {
    const item = await addVideoSource(sourceName.value, sourceUrl.value)
    sourceName.value = ''
    sourceUrl.value = ''
    selectedId.value = item.id
    message.value = '影视源已添加。建议先点击“测试源”验证接口。'
  })
}
function importConfig() {
  void change(async () => {
    const result = await importTvBoxConfig(tvboxText.value)
    tvboxText.value = ''
    message.value = '导入 ' + result.imported + ' 个 MacCMS 源，跳过 ' + result.skipped + ' 个不兼容或重复源。'
  })
}
function importUrl() {
  void change(async () => {
    const result = await importTvBoxUrl(tvboxUrl.value.trim())
    message.value = result.imported > 0
      ? '通过配置 URL 新增 ' + result.imported + ' 个兼容 MacCMS 源；跳过 ' + result.skipped + ' 个不兼容或重复源。'
      : '配置已读取，但未找到可导入的 MacCMS type=1 源；跳过 ' + result.skipped + ' 项。此配置可能依赖 TVBox Spider/JAR，暂不支持。'
  })
}
function toggle(source: VideoSource) {
  void change(async () => {
    await setVideoSourceEnabled(source.id, !source.enabled)
    message.value = source.name + ' 状态已更新'
  })
}
function remove(source: VideoSource) {
  if (!window.confirm('删除影视源“' + source.name + '”？已下载文件不会被删除。')) return
  void change(async () => {
    await removeVideoSource(source.id)
    message.value = '已删除 ' + source.name
  })
}
function testSource() {
  void change(async () => {
    const result = await testVideoSource(selectedId.value)
    message.value = '源接口响应正常，样本影片 ' + result.sampleCount + ' 条。此结果不代表所有剧集均可下载。'
  })
}
async function search(nextPage = 1) {
  if (!selectedId.value || loading.value || !keyword.value.trim()) return
  loading.value = true
  resetMessages()
  detail.value = null
  try {
    const result = await searchVideoSource(selectedId.value, keyword.value, nextPage)
    results.value = result.items
    page.value = result.page
    pageCount.value = result.pageCount
    message.value = '找到 ' + result.items.length + ' 条影片记录。请选择影片查看剧集。'
  } catch (e) { error.value = e instanceof Error ? e.message : '搜索失败' }
  finally { loading.value = false }
}
async function open(item: VideoItem) {
  loading.value = true
  resetMessages()
  try { detail.value = await detailVideoSource(selectedId.value, item.id) }
  catch (e) { error.value = e instanceof Error ? e.message : '获取剧集失败' }
  finally { loading.value = false }
}
async function download(lineIndex: number, episodeIndex: number) {
  if (!detail.value || downloading.value) return
  const videoId = detail.value.id
  const key = lineIndex + '-' + episodeIndex
  downloading.value = key
  resetMessages()
  try {
    const task = await downloadVideoEpisode(selectedId.value, videoId, lineIndex, episodeIndex)
    message.value = '已加入下载中心：' + task.fileName + '（' + task.gid + '）'
    emit('task-added')
  } catch (e) { error.value = e instanceof Error ? e.message : '提交下载失败' }
  finally { downloading.value = '' }
}
onMounted(() => { void refresh().catch(e => { error.value = e instanceof Error ? e.message : '加载源失败' }) })
</script>

<template>
  <section class="panel video-source-panel">
    <h2>影视源解析下载</h2>
    <p class="video-hint">独立影视源模块：添加 MacCMS JSON API 或导入兼容 TVBox JSON，搜索影片、选择剧集后下载公开 MP4 直链。仅处理有权下载的内容。HLS 点播节目下载后由 FFmpeg 本地封装 MP4。</p>
    <form class="video-grid" @submit.prevent="add">
      <label for="vs-name">源名称</label>
      <input id="vs-name" v-model="sourceName" maxlength="80" placeholder="我的影视源" required />
      <label for="vs-url">MacCMS JSON API</label>
      <input id="vs-url" v-model="sourceUrl" type="url" placeholder="https://example.com/api.php/provide/vod/" required />
      <button type="submit" class="primary-button" :disabled="changing">添加影视源</button>
    </form>
    <form class="video-import-url" @submit.prevent="importUrl">
      <label for="vs-config-url">TVBox 配置 URL</label>
      <input id="vs-config-url" v-model="tvboxUrl" type="url" required
        placeholder="https://api.hgyx.vip/hgyx.json" :disabled="changing" />
      <button type="submit" class="ghost-button" :disabled="changing || !tvboxUrl.trim()">从 URL 导入兼容影视源</button>
    </form>
    <p class="video-hint">配置 URL 不等于影片接口。仅识别并保存其中 type=1 MacCMS API；type=3 Spider/JAR/脚本源会显示为跳过，不会执行不可信代码。</p>
    <details class="video-import">
      <summary>导入 TVBox JSON 配置（仅 MacCMS type=1）</summary>
      <textarea v-model="tvboxText" rows="4" placeholder='{"sites":[{"type":1,"name":"示例","api":"https://example.com/api.php/provide/vod/"}]}' />
      <button type="button" class="ghost-button" :disabled="changing || !tvboxText.trim()" @click="importConfig">导入兼容源</button>
      <p class="video-hint">不执行 jar、JavaScript Spider、脚本解析，也不会下载配置中的扩展组件。</p>
    </details>
    <div v-if="sources.length" class="video-sources">
      <strong>已添加的源</strong>
      <div v-for="source in sources" :key="source.id" class="video-source-row">
        <span>{{ source.name }} <small>{{ source.enabled ? '启用' : '停用' }}</small></span>
        <div>
          <button class="ghost-button" type="button" :disabled="changing" @click="toggle(source)">{{ source.enabled ? '停用' : '启用' }}</button>
          <button class="ghost-button" type="button" :disabled="changing" @click="remove(source)">删除</button>
        </div>
      </div>
    </div>
    <form class="video-search" @submit.prevent="search(1)">
      <select v-model="selectedId" aria-label="选择影视源" @change="onSourceChanged">
        <option value="">选择已启用的影视源</option>
        <option v-for="source in sources.filter(item => item.enabled)" :key="source.id" :value="source.id">{{ source.name }}</option>
      </select>
      <input v-model="keyword" aria-label="影视名称" placeholder="输入影片、电视剧名称" maxlength="80" />
      <button class="primary-button" type="submit" :disabled="!selectedId || !keyword.trim() || loading">搜索</button>
      <button class="ghost-button" type="button" :disabled="!selectedId || changing" @click="testSource">测试源</button>
    </form>
    <p v-if="message" class="video-message" role="status">{{ message }}</p>
    <p v-if="error" class="video-error" role="alert">{{ error }}</p>
    <div v-if="results.length" class="video-results">
      <div v-for="item in results" :key="item.id" class="video-result">
        <span>{{ item.title }} <small>{{ item.remarks }}</small></span>
        <button type="button" class="ghost-button" :disabled="loading" @click="open(item)">查看剧集</button>
      </div>
      <div class="video-pages">
        <button class="ghost-button" type="button" :disabled="loading || page <= 1" @click="search(page - 1)">上一页</button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button class="ghost-button" type="button" :disabled="loading || page >= pageCount" @click="search(page + 1)">下一页</button>
      </div>
    </div>
    <div v-if="detail" class="video-detail">
      <h3>{{ detail.title }} · 剧集</h3>
      <p v-if="!detail.lines.length" class="video-hint">源没有提供有效播放线路。</p>
      <div v-for="(line, lineIndex) in detail.lines" :key="lineIndex" class="video-line">
        <h4>{{ line.name }}</h4>
        <div class="video-episodes">
          <button v-for="(episode, episodeIndex) in line.episodes" :key="episodeIndex"
            type="button" class="ghost-button"
            :disabled="episode.kind === 'unsupported' || !!downloading"
            :title="episode.kind === 'hls' ? '下载并封装 HLS 视频到 MP4' : episode.kind === 'unsupported' ? '未知解析脚本/非 MP4 直链' : '添加 MP4 到下载任务'"
            @click="download(lineIndex, episodeIndex)">
            {{ episode.label }} · {{ episode.kind === 'mp4' ? '下载 MP4' : episode.kind === 'hls' ? '下载 HLS' : '不支持' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.video-source-panel { padding: 24px; margin-bottom: 18px; }
.video-source-panel h2 { margin-bottom: 8px; }
.video-source-panel h4 { margin: 12px 0; }
.video-hint { color: #64748b; font-size: 13px; line-height: 1.6; margin-bottom: 16px; }
.video-grid { display: grid; grid-template-columns: 125px 1fr; gap: 10px; align-items: center; }
.video-grid input, .video-search input, .video-search select, .video-import textarea { width: 100%; min-width: 0; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; }
.video-grid button { grid-column: 2; justify-self: start; }
.video-import-url { display: flex; gap: 10px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
.video-import-url input { flex: 1 1 280px; min-width: 0; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; }
.video-import-url label { font-size: 13px; font-weight: 600; }
.video-import { margin: 18px 0; }
.video-import summary { cursor: pointer; margin-bottom: 8px; }
.video-import textarea { display: block; margin: 10px 0; }
.video-sources { margin: 16px 0; }
.video-source-row, .video-result, .video-search, .video-pages { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.video-source-row, .video-result { padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
.video-source-row button { margin-left: 6px; }
.video-source-row small, .video-result small { color: #64748b; }
.video-search { justify-content: start; margin: 16px 0; flex-wrap: wrap; }
.video-search select { max-width: 240px; }
.video-search input { flex: 1; }
.video-message { color: #065f46; margin: 8px 0; }
.video-error { color: #b91c1c; margin: 8px 0; }
.video-detail, .video-results { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
.video-line { margin-top: 12px; }
.video-episodes { display: flex; flex-wrap: wrap; gap: 8px; }
.video-episodes button { max-width: 100%; }
.video-pages { justify-content: center; margin: 12px 0; }
@media(max-width: 680px) { .video-grid { grid-template-columns: 1fr; } .video-grid button { grid-column: 1; } .video-source-row { align-items: flex-start; } }
</style>
