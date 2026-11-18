<script setup lang="ts">
import { ref } from 'vue'
import { addDownloadTask } from '../api/downloads'

interface MagnetCandidate {
  hash: string
  title: string
  size: string
  magnet: string
  isHD?: boolean
  hasSubtitle?: boolean
}

interface MagnetResult {
  code: string
  source: string
  items: MagnetCandidate[]
}

interface MagnetMovie {
  code: string
  title: string
}

interface GeneralSourceStatus {
  id: string
  name: string
  ok: boolean
  count: number
  error?: string
}
interface GeneralResult {
  query: string
  category: string
  source: string
  items: Array<MagnetCandidate & { source: string; category: string; seeders: number | null }>
  sources: GeneralSourceStatus[]
}
interface KeywordResult {
  query: string
  source: string
  movies: MagnetMovie[]
}

const searchMode = ref<'general' | 'keyword' | 'code'>('general')
const categoryFilter = ref('all')
const sourceFilter = ref('all')
const showFilters = ref(false)
const categoryLabels: Record<string, string> = {
  all: '全部类型', movie: '电影', tv: '电视剧', book: '电子书', anime: '动漫', learning: '课程/学术'
}
const sourceLabels: Record<string, string> = {
  all: '全部来源', bitsearch: 'BitSearch', nyaa: 'Nyaa', academic: 'Academic Torrents'
}
const generalResult = ref<GeneralResult | null>(null)
const query = ref('')
const searching = ref(false)
const loadingCode = ref('')
const downloading = ref('')
const searched = ref(false)
const movies = ref<MagnetMovie[]>([])
const selectedCode = ref('')
const source = ref('')
const result = ref<MagnetResult | null>(null)
const message = ref('')
const error = ref('')

function resetResults() {
  searched.value = false
  movies.value = []
  generalResult.value = null
  result.value = null
  selectedCode.value = ''
  source.value = ''
  error.value = ''
  message.value = ''
}

async function getSearchResult(path: string, general = false): Promise<unknown> {
  const response = await fetch((general ? '/api/magnets/general-search?' : '/api/magnets/search?') + path)
  const body = await response.json()
  if (!response.ok || !body.ok) throw new Error(body.message || '搜索失败')
  return body.result
}

async function search() {
  if (searching.value || loadingCode.value || !query.value.trim()) return
  resetResults()
  searching.value = true
  try {
    const trimmed = query.value.trim()
    if (searchMode.value === 'general') {
      const params = new URLSearchParams({ q: trimmed, category: categoryFilter.value, source: sourceFilter.value })
      generalResult.value = await getSearchResult(params.toString(), true) as GeneralResult
    } else if (searchMode.value === 'keyword') {
      const data = await getSearchResult('q=' + encodeURIComponent(trimmed)) as KeywordResult
      movies.value = data.movies
      source.value = data.source
    } else {
      result.value = await getSearchResult('code=' + encodeURIComponent(trimmed)) as MagnetResult
      selectedCode.value = result.value.code
    }
    searched.value = true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '搜索失败'
  } finally {
    searching.value = false
  }
}

async function showMagnets(code: string) {
  if (searching.value || loadingCode.value) return
  error.value = ''
  message.value = ''
  result.value = null
  selectedCode.value = code
  loadingCode.value = code
  try {
    result.value = await getSearchResult('code=' + encodeURIComponent(code)) as MagnetResult
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '无法获取磁力'
  } finally {
    loadingCode.value = ''
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
    <div class="magnet-heading">
      <div>
        <h2>磁力搜索</h2>
        <p class="magnet-help">一个搜索框查找影视、图书、动漫与学术资源；番号检索可在左侧切换。请仅下载授权资源。</p>
      </div>
    </div>
    <form class="magnet-form" @submit.prevent="search">
      <div class="magnet-search-row">
        <select id="magnet-mode" v-model="searchMode" aria-label="搜索模式" :disabled="searching || !!loadingCode" @change="resetResults">
          <option value="general">通用搜索</option>
          <option value="keyword">番号模糊</option>
          <option value="code">番号精确</option>
        </select>
        <input id="magnet-code" v-model="query" :maxlength="searchMode === 'code' ? 32 : 80" autocomplete="off"
          :aria-label="searchMode === 'code' ? '输入完整番号' : '输入搜索关键词'"
          :placeholder="searchMode === 'general' ? '输入电影、电视剧、图书名称或关键词' : searchMode === 'keyword' ? '输入关键词或部分番号，如 FPRE-24' : '输入完整番号，如 FPRE-249'"
          :disabled="searching || !!loadingCode" />
        <button class="primary-button" :disabled="searching || !!loadingCode || !query.trim()" type="submit">{{ searching ? '搜索中…' : '搜索' }}</button>
      </div>
      <div v-if="searchMode === 'general'" class="magnet-filter-bar">
        <button class="filter-toggle" type="button" :aria-expanded="showFilters" aria-controls="magnet-advanced" :disabled="searching" @click="showFilters = !showFilters">{{ showFilters ? '收起筛选' : '分类与来源筛选' }}</button>
        <span class="magnet-filter-summary">{{ categoryLabels[categoryFilter] || '全部类型' }} · {{ sourceLabels[sourceFilter] || '全部来源' }}</span>
      </div>
      <div v-if="searchMode === 'general' && showFilters" id="magnet-advanced" class="magnet-advanced">
        <label for="magnet-category">资源分类</label>
        <select id="magnet-category" v-model="categoryFilter" :disabled="searching">
          <option value="all">全部类型</option>
          <option value="movie">电影</option>
          <option value="tv">电视剧</option>
          <option value="book">图书 / 电子书</option>
          <option value="anime">动漫</option>
          <option value="learning">课程 / 学术</option>
        </select>
        <label for="magnet-source">搜索源</label>
        <select id="magnet-source" v-model="sourceFilter" :disabled="searching">
          <option value="all">全部通用搜索源</option>
          <option value="bitsearch">BitSearch（综合）</option>
          <option value="nyaa">Nyaa（动漫）</option>
          <option value="academic">Academic Torrents（学术）</option>
        </select>
      </div>
    </form>
    <p v-if="error" class="magnet-error" role="alert">{{ error }}</p>
    <p v-if="message" class="magnet-success" role="status">{{ message }}</p>
    <p v-if="searched && searchMode === 'general' && generalResult && !generalResult.items.length">当前检索源没有返回有效磁力。可以尝试英文名称、简化关键词或切换搜索源。</p>
    <div v-if="searchMode === 'general' && generalResult" class="magnet-results">
      <p>找到 {{ generalResult.items.length }} 个磁力（已按 Info Hash 去重） · {{ generalResult.source }}。做种数是索引信息，不保证实际下载速度。</p>
      <p v-for="status in generalResult.sources" :key="status.id" :class="status.ok ? 'magnet-help' : 'magnet-error'">
        {{ status.name }}：{{ status.ok ? '返回 ' + status.count + ' 条' : '不可用：' + (status.error || '未知原因') }}
      </p>
      <div v-for="item in generalResult.items" :key="item.hash" class="magnet-result">
        <div class="magnet-result-info">
          <strong>{{ item.title }}</strong>
          <small>{{ item.source }} · {{ item.category || '类别未知' }} · {{ item.size || '大小未知' }} · 做种：{{ item.seeders === null ? '未知' : item.seeders }}</small>
        </div>
        <div class="magnet-buttons">
          <button class="ghost-button" type="button" @click="copyMagnet(item.magnet)">复制磁力</button>
          <button class="primary-button" type="button" :disabled="Boolean(downloading)" @click="download(item)">{{ downloading === item.hash ? '添加中…' : '下载' }}</button>
        </div>
      </div>
    </div>
    <p v-if="searched && searchMode === 'keyword' && !movies.length">没有找到匹配影片。搜索源可能未收录该关键词，也可能暂时无法返回完整结果。</p>
    <p v-if="searched && searchMode === 'code' && result && !result.items.length">没有找到磁力资源，或搜索源尚未收录该番号。</p>

    <div v-if="searchMode === 'keyword' && movies.length" class="magnet-results">
      <p>找到 {{ movies.length }} 部影片 · 来源：{{ source }}。选择影片后查询磁力（仅显示首批结果）。</p>
      <div v-for="movie in movies" :key="movie.code" class="magnet-result">
        <div class="magnet-result-info">
          <strong>{{ movie.code }}</strong>
          <span>{{ movie.title }}</span>
        </div>
        <button class="primary-button" type="button" :disabled="Boolean(loadingCode || searching)"
          @click="showMagnets(movie.code)">{{ loadingCode === movie.code ? '获取中…' : '查看磁力' }}</button>
      </div>
    </div>

    <div v-if="result && searchMode !== 'general'" class="magnet-results">
      <h3>{{ selectedCode }} 的磁力资源</h3>
      <p v-if="!result.items.length">该影片暂无磁力资源。可以选择其他搜索结果。</p>
      <p v-else>找到 {{ result.items.length }} 个磁力 · 来源：{{ result.source }}（下载能力取决于做种及网络情况）</p>
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
.magnet-panel { padding: 24px 28px; }
.magnet-heading { margin-bottom: 20px; }
.magnet-heading h2 { margin: 0 0 7px; color: #0f172a; font-size: 19px; font-weight: 650; }
.magnet-help { color: #64748b; line-height: 1.55; font-size: 13px; }
.magnet-form { display: grid; gap: 10px; margin: 0 0 16px; }
.magnet-search-row { display: flex; align-items: stretch; gap: 10px; }
.magnet-search-row input { flex: 1; min-width: 0; padding: 11px 14px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; outline: none; }
.magnet-search-row input:focus { border-color: #059669; box-shadow: 0 0 0 3px #d1fae5; background: #fff; }
.magnet-search-row select, .magnet-advanced select { border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; padding: 10px 12px; color: #334155; font: inherit; }
.magnet-search-row select { width: 135px; }
.magnet-filter-bar { display: flex; align-items: center; gap: 12px; padding-left: 2px; }
.filter-toggle { border: 0; color: #047857; background: none; font: inherit; font-size: 13px; font-weight: 650; padding: 4px 0; }
.filter-toggle:hover { text-decoration: underline; }
.magnet-filter-summary { color: #64748b; font-size: 12px; }
.magnet-advanced { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
.magnet-advanced label { color: #475569; font-size: 13px; font-weight: 600; }
.magnet-advanced select { min-width: 140px; }
.magnet-results { margin-top: 16px; }
.magnet-results h3 { margin: 18px 0 10px; }
.magnet-result { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 12px; border-top: 1px solid #e2e8f0; flex-wrap: wrap; }
.magnet-result-info { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; flex: 1 1 240px; }
.magnet-result-info small { color: #64748b; }
.magnet-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.magnet-error { color: #b91c1c; font-size: 13px; }
.magnet-success { color: #047857; font-size: 13px; }
@media (max-width: 640px) {
  .magnet-panel { padding: 18px 16px; }
  .magnet-search-row { flex-wrap: wrap; }
  .magnet-search-row select { width: calc(40% - 5px); }
  .magnet-search-row input { width: calc(60% - 5px); flex: 1; }
  .magnet-search-row .primary-button { width: 100%; }
}
</style>
