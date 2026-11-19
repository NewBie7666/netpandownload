<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { VideoItem, VideoSource, VideoSourceImportResult } from '../../shared/videoSources'
import { addHlsDownloadTask } from '../api/downloads'
import {
  addVideoSource, detailVideoSource, downloadVideoEpisode, importTvBoxConfig, importTvBoxUrl,
  listVideoSources, removeVideoSource, searchVideoSource,
  setVideoSourceEnabled, testVideoSource
} from '../api/videoSources'

const emit = defineEmits<{ 'task-added': []; 'view-downloads': [] }>()
const sources = ref<VideoSource[]>([])
const selectedId = ref('')
const sourceName = ref('')
const sourceUrl = ref('')
const configInput = ref('')
const importReport = ref<VideoSourceImportResult | null>(null)
const keyword = ref('')
const results = ref<VideoItem[]>([])
const detail = ref<VideoItem | null>(null)
const page = ref(1)
const pageCount = ref(1)
const loading = ref(false)
const changing = ref(false)
const downloading = ref(false)
const hlsUrl = ref('')
const hlsFileName = ref('')
const hlsLoading = ref(false)
const hlsError = ref('')
const queuedFile = ref('')
const message = ref('')
const error = ref('')

function resetMessages() { message.value = ''; error.value = '' }
function resetSelection() {
  results.value = []
  detail.value = null
  page.value = 1
  pageCount.value = 1
}

function onSourceChanged() { resetSelection(); resetMessages() }
async function refresh() {
  sources.value = await listVideoSources()
  if (!sources.value.some(source => source.id === selectedId.value && source.enabled)) {
    selectedId.value = sources.value.find(source => source.enabled)?.id || ''
    resetSelection()
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
    resetSelection()
    message.value = '影视源已添加。建议先点击“测试源”验证接口。'
  })
}
function importSource() {
  void change(async () => {
    const input = configInput.value.trim()
    if (!input) throw new Error('请输入 TVBox 配置 URL 或粘贴完整 JSON')
    const previousIds = new Set(sources.value.map(source => source.id))
    const result = /^https?:\/\//i.test(input) ? await importTvBoxUrl(input) : await importTvBoxConfig(input)
    importReport.value = result
    selectedId.value = result.sources.find(source => source.enabled && !previousIds.has(source.id))?.id
      || result.sources.find(source => source.enabled)?.id || ''
    resetSelection()
    message.value = result.imported > 0
      ? '已保存 ' + result.imported + ' 个站点。选择站点后可测试和搜索，执行结果取决于该站点的运行依赖。'
      : result.alreadyPresent > 0
        ? '配置已读取，' + result.alreadyPresent + ' 个站点已存在，选择站点后测试和搜索。'
        : '配置已读取，但暂时没有可由本程序直接搜索的站点。查看下方兼容性说明。'
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
  downloading.value = true
  resetMessages()
  message.value = '正在获取剧集并解析媒体地址，请稍候。'
  try {
    const task = await downloadVideoEpisode(selectedId.value, videoId, lineIndex, episodeIndex)
    queuedFile.value = task.fileName
    emit('task-added')
  } catch (e) { error.value = e instanceof Error ? e.message : '提交下载失败' }
  finally { downloading.value = false; message.value = '' }
}

async function downloadHls() {
  if (hlsLoading.value || !hlsUrl.value.trim()) return
  hlsLoading.value = true
  hlsError.value = ''
  try {
    const task = await addHlsDownloadTask({ url: hlsUrl.value.trim(), fileName: hlsFileName.value.trim() || undefined })
    queuedFile.value = task.fileName
    hlsUrl.value = ''
    hlsFileName.value = ''
    emit('task-added')
  } catch (e) {
    hlsError.value = e instanceof Error ? e.message : '添加 HLS 下载失败'
  } finally {
    hlsLoading.value = false
  }
}

onMounted(() => { void refresh().catch(e => { error.value = e instanceof Error ? e.message : '加载源失败' }) })
</script>

<template>
  <section class="panel video-source-panel">
    <h2>影视源解析下载</h2>
    <p class="video-hint">从影视仓复制 TVBox 配置网址或 JSON，选择站点搜索影片并选集下载。支持 Type3 JavaScript、JVM 与部分 DEX；依赖 Android 原生库的加固站点尚未兼容。</p>
    <form class="video-config-form" @submit.prevent="importSource">
      <label for="vs-config-input"><strong>影视源配置 URL / JSON</strong></label>
      <textarea id="vs-config-input" v-model="configInput" rows="2" required
        :disabled="changing || loading || downloading" placeholder="https://example.com/tvbox.json&#10;或直接粘贴 { &quot;sites&quot;: [...] }" />
      <div class="video-config-actions">
        <button type="submit" class="primary-button" :disabled="changing || loading || downloading || !configInput.trim()">
          {{ changing ? '正在解析...' : '一键导入影视源' }}
        </button>
      </div>
    </form>
    <div v-if="importReport" class="video-import-report" role="status">
      <strong>配置识别结果：{{ importReport.total }} 个站点</strong>
      <p>新增站点 {{ importReport.imported }} 个；已存在 {{ importReport.alreadyPresent }} 个；暂不支持 {{ importReport.unsupported }} 个；无效/超限 {{ importReport.invalid }} 个。</p>
      <details v-if="importReport.unsupportedSites.length">
        <summary>查看尚不兼容的站点（{{ importReport.unsupported }}）</summary>
        <ul>
          <li v-for="(site, i) in importReport.unsupportedSites" :key="i">
            {{ site.name }}（type={{ site.type }}）：{{ site.reason }}
          </li>
        </ul>
      </details>
    </div>
    <details class="video-import video-advanced">
      <summary>高级设置：手动添加单个 MacCMS API</summary>
      <p class="video-hint">仅在你有独立的 MacCMS JSON API 地址时使用，不适用于普通 TVBox 源配置 URL。</p>
      <form class="video-grid" @submit.prevent="add">
        <label for="vs-name">源名称</label>
        <input id="vs-name" v-model="sourceName" maxlength="80" placeholder="例如：我的 MacCMS API" required />
        <label for="vs-url">MacCMS JSON API</label>
        <input id="vs-url" v-model="sourceUrl" type="url" placeholder="https://example.com/api.php/provide/vod/" required />
        <button type="submit" class="ghost-button" :disabled="changing || loading || downloading">添加单个 MacCMS API</button>
      </form>
    </details>
    <div v-if="sources.length" class="video-sources">
      <strong>已保存站点（{{ sources.length }}）</strong>
      <div v-for="source in sources" :key="source.id" class="video-source-row">
        <span>{{ source.name }} <small>{{ source.type === 'type3' ? source.runtime === 'javascript' ? 'Type3 JavaScript' : 'Type3 Java / DEX' : 'MacCMS' }} · {{ source.enabled ? '启用' : '停用' }}</small></span>
        <div>
          <button class="ghost-button" type="button" :disabled="changing || loading || downloading" @click="toggle(source)">{{ source.enabled ? '停用' : '启用' }}</button>
          <button class="ghost-button" type="button" :disabled="changing || loading || downloading" @click="remove(source)">删除</button>
        </div>
      </div>
    </div>
    <p v-if="!sources.length" class="video-hint">尚无已保存站点，请先在上方粘贴 TVBox 配置地址并导入。</p>
    <form class="video-search" @submit.prevent="search(1)">
      <select v-model="selectedId" aria-label="选择影视源" :disabled="changing || loading || downloading" @change="onSourceChanged">
        <option value="">选择已启用的影视源</option>
        <option v-for="source in sources.filter(item => item.enabled)" :key="source.id" :value="source.id">{{ source.name }}</option>
      </select>
      <input v-model="keyword" aria-label="影视名称" placeholder="输入影片、电视剧名称" maxlength="80" />
      <button class="primary-button" type="submit" :disabled="!selectedId || !keyword.trim() || changing || loading || downloading">搜索</button>
      <button class="ghost-button" type="button" :disabled="!selectedId || changing || loading || downloading" @click="testSource">测试源</button>
    </form>
    <p v-if="message" class="video-message" role="status">{{ message }}</p>
    <p v-if="error" class="video-error" role="alert">{{ error }}</p>
    <div v-if="results.length" class="video-results">
      <div v-for="item in results" :key="item.id" class="video-result">
        <span>{{ item.title }} <small>{{ item.remarks }}</small></span>
        <button type="button" class="ghost-button" :disabled="changing || loading || downloading" @click="open(item)">查看剧集</button>
      </div>
      <div class="video-pages">
        <button class="ghost-button" type="button" :disabled="changing || loading || downloading || page <= 1" @click="search(page - 1)">上一页</button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button class="ghost-button" type="button" :disabled="changing || loading || downloading || page >= pageCount" @click="search(page + 1)">下一页</button>
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
            :disabled="episode.kind === 'unsupported' || changing || loading || downloading"
            :title="episode.kind === 'resolve' ? '调用 Type3 播放解析后下载' : episode.kind === 'hls' ? '下载并封装 HLS 视频到 MP4' : episode.kind === 'unsupported' ? '该剧集需要额外解析器' : '添加 MP4 到下载任务'"
            @click="download(lineIndex, episodeIndex)">
            {{ episode.label }} · {{ episode.kind === 'resolve' ? '解析并下载' : episode.kind === 'mp4' ? '下载 MP4' : episode.kind === 'hls' ? '下载 HLS' : '不支持' }}
          </button>
        </div>
      </div>
    </div>
    <details class="video-import">
      <summary>直接下载 m3u8</summary>
      <p class="video-hint">粘贴影视仓或播放器提供的最终 m3u8 点播地址，下载后合并为 MP4。</p>
      <form class="video-grid" @submit.prevent="downloadHls">
        <label for="vs-hls-url">m3u8 地址</label>
        <input id="vs-hls-url" v-model="hlsUrl" type="url" required :disabled="hlsLoading" placeholder="https://example.com/video/index.m3u8" />
        <label for="vs-hls-name">MP4 文件名（可选）</label>
        <input id="vs-hls-name" v-model="hlsFileName" :disabled="hlsLoading" placeholder="影片名.mp4" />
        <button class="primary-button" type="submit" :disabled="hlsLoading || !hlsUrl.trim()">
          {{ hlsLoading ? '正在提交…' : '添加 HLS 下载任务' }}
        </button>
      </form>
      <p v-if="hlsError" class="video-error" role="alert">{{ hlsError }}</p>
    </details>
    <div v-if="queuedFile" class="video-config-actions">
      <p class="video-message" role="status">已加入下载任务：{{ queuedFile }}</p>
      <button class="ghost-button" type="button" @click="emit('view-downloads')">查看下载任务</button>
    </div>
  </section>
</template>

<style scoped>
.video-source-panel { padding: 24px; margin-bottom: 18px; }
.video-source-panel h2 { margin-bottom: 8px; }
.video-source-panel h4 { margin: 12px 0; }
.video-hint { color: #64748b; font-size: 13px; line-height: 1.6; margin-bottom: 16px; }
.video-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; align-items: center; }
.video-config-form { display: grid; gap: 10px; }
.video-config-form textarea { resize: vertical; width: 100%; min-height: 74px; padding: 12px; border: 1px solid #cbd5e1; border-radius: 6px; font: inherit; }
.video-config-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.video-import-report { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-top: 16px; }
.video-import-report p { margin: 10px 0; }
.video-import-report ul { padding-left: 25px; margin-top: 10px; }
.video-import-report li { margin-bottom: 6px; overflow-wrap: anywhere; }
.video-advanced { margin-top: 18px; }
.video-grid input, .video-search input, .video-search select { width: 100%; min-width: 0; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; }
.video-grid button { grid-column: 2; justify-self: start; }
.video-import { margin: 18px 0; }
.video-import summary { cursor: pointer; margin-bottom: 8px; }
.video-sources { margin: 16px 0; }
.video-source-row, .video-result, .video-search, .video-pages { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.video-source-row, .video-result { padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
.video-source-row button { margin-left: 6px; }
.video-source-row small, .video-result small { color: #64748b; }
.video-search { justify-content: start; margin: 16px 0; flex-wrap: wrap; }
.video-search select { max-width: 240px; }
.video-search input { flex: 1 1 180px; }
.video-message { color: #065f46; margin: 8px 0; }
.video-error { color: #b91c1c; margin: 8px 0; }
.video-detail, .video-results { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
.video-line { margin-top: 12px; }
.video-episodes { display: flex; flex-wrap: wrap; gap: 8px; }
.video-episodes button { max-width: 100%; }
.video-pages { justify-content: center; margin: 12px 0; }
@media(max-width: 680px) { .video-grid { grid-template-columns: 1fr; } .video-grid button { grid-column: 1; } .video-source-row { align-items: flex-start; } }
</style>
