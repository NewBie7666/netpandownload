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
    <h2>BT 磁力聚合搜索</h2>
    <p class="magnet-help">默认检索电影、电视剧、书籍、动漫及公开课程的综合 BT 索引；各来源可独立选择。番号搜索单独保留。结果不代表资源可以下载，且请确保拥有下载及分享授权。</p>
    <form class="magnet-form" @submit.prevent="search">
      <label for="magnet-mode">方式</label>
      <select id="magnet-mode" v-model="searchMode" :disabled="searching || !!loadingCode" @change="resetResults">
        <option value="general">通用磁力搜索</option>
        <option value="keyword">番号关键词 / 部分番号</option>
        <option value="code">完整番号（精确）</option>
      </select>
      <label for="magnet-code">{{ searchMode === 'code' ? '番号' : '关键词' }}</label>
      <select v-if="searchMode === 'general'" id="magnet-category" v-model="categoryFilter" aria-label="资源分类" :disabled="searching">
        <option value="all">全部类型</option>
        <option value="movie">电影</option>
        <option value="tv">电视剧</option>
        <option value="book">图书 / 电子书</option>
        <option value="anime">动漫</option>
        <option value="learning">课程 / 学术</option>
      </select>
      <select v-if="searchMode === 'general'" id="magnet-source" v-model="sourceFilter" aria-label="搜索源" :disabled="searching">
        <option value="all">全部通用搜索源</option>
        <option value="bitsearch">BitSearch（综合）</option>
        <option value="nyaa">Nyaa（动漫）</option>
        <option value="academic">Academic Torrents（学术）</option>
      </select>
      <input id="magnet-code" v-model="query" :maxlength="searchMode === 'code' ? 32 : 80" autocomplete="off"
        :placeholder="searchMode === 'general' ? '例如 Night of the Living Dead、Ubuntu、小说标题' : searchMode === 'keyword' ? '例如 FPRE、FPRE-24' : '例如 FPRE-249'"
        :disabled="searching || !!loadingCode" />
      <button class="primary-button" :disabled="searching || !!loadingCode || !query.trim()" type="submit">{{ searching ? '搜索中…' : '搜索' }}</button>
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
.magnet-panel { margin-top: 22px; }
.magnet-panel h2 { margin: 0 0 12px; }
.magnet-help { color: #64748b; line-height: 1.6; }
.magnet-form { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 20px 0; }
.magnet-form input { flex: 1 1 240px; min-width: 0; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; }
.magnet-form select { max-width: 210px; min-width: 0; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
.magnet-results { margin-top: 16px; }
.magnet-results h3 { margin: 18px 0 10px; }
.magnet-result { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 12px; border-top: 1px solid #e2e8f0; flex-wrap: wrap; }
.magnet-result-info { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; flex: 1 1 240px; }
.magnet-result-info small { color: #64748b; }
.magnet-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.magnet-error { color: #b91c1c; }
.magnet-success { color: #047857; }
</style>
