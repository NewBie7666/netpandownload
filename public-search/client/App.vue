<script setup lang="ts">
import { computed, ref } from 'vue'

type SearchMode = 'auto' | 'general' | 'fuzzy' | 'exact'

interface SearchItem {
  hash: string
  title: string
  size?: string
  magnet: string
  source?: string
  category?: string
  seeders?: number | null
  isHD?: boolean
  hasSubtitle?: boolean
}

interface MovieMatch {
  code: string
  title: string
}

interface SourceStatus {
  id: string
  name: string
  ok: boolean
  count: number
  error?: string
}

interface SearchResult {
  query: string
  items: SearchItem[]
  movies: MovieMatch[]
  sources: SourceStatus[]
}

interface ApiErrorBody {
  ok: false
  error?: string
  message?: string
}

interface ApiSuccessBody {
  ok: true
  result?: unknown
}

const mode = ref<SearchMode>('auto')
const category = ref('all')
const source = ref('all')
const query = ref('')
const loading = ref(false)
const searched = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const result = ref<SearchResult | null>(null)
const copiedHash = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined

const hasResults = computed(() => Boolean(result.value?.items.length || result.value?.movies.length))
const visibleItems = computed(() => result.value?.items ?? [])
const visibleMovies = computed(() => result.value?.movies ?? [])

const modeLabels: Record<SearchMode, string> = {
  auto: '自动匹配',
  general: '通用匹配',
  fuzzy: '宽泛匹配',
  exact: '精确匹配'
}

function resetView() {
  result.value = null
  searched.value = false
  errorMessage.value = ''
  statusMessage.value = ''
  copiedHash.value = ''
}

function clearCopyTimer() {
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseItem(value: unknown): SearchItem | null {
  if (!isRecord(value)) return null
  const hash = stringValue(value.hash)
  const title = stringValue(value.title)
  const magnet = stringValue(value.magnet)
  if (!hash || !title || !magnet) return null
  return {
    hash,
    title,
    magnet,
    size: stringValue(value.size),
    source: stringValue(value.source),
    category: stringValue(value.category),
    seeders: numberValue(value.seeders),
    isHD: value.isHD === true,
    hasSubtitle: value.hasSubtitle === true
  }
}

function parseMovie(value: unknown): MovieMatch | null {
  if (!isRecord(value)) return null
  const code = stringValue(value.code)
  const title = stringValue(value.title)
  return code && title ? { code, title } : null
}

function parseSourceStatus(value: unknown): SourceStatus | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id)
  const name = stringValue(value.name)
  const count = numberValue(value.count)
  if (!id || !name || typeof count !== 'number') return null
  return {
    id,
    name,
    count,
    ok: value.ok === true,
    error: stringValue(value.error)
  }
}

function parseResult(value: unknown): SearchResult {
  if (!isRecord(value)) throw new Error('服务端返回的数据格式不正确')
  const queryValue = stringValue(value.query) ?? ''
  const items = Array.isArray(value.items) ? value.items.map(parseItem).filter((item): item is SearchItem => item !== null) : []
  const movies = Array.isArray(value.movies) ? value.movies.map(parseMovie).filter((movie): movie is MovieMatch => movie !== null) : []
  const sources = Array.isArray(value.sources) ? value.sources.map(parseSourceStatus).filter((status): status is SourceStatus => status !== null) : []
  return { query: queryValue, items, movies, sources }
}

function safeErrorMessage(body: ApiErrorBody): string {
  // Use an allowlist so private-client diagnostics are never exposed by this public UI.
  const publicMessages: Record<string, string> = {
    invalid_query: '请输入有效的查询内容。',
    invalid_code: '请输入有效的查询内容。',
    sources_unavailable: '当前查询源暂时不可用，请稍后再试。',
    source_unreachable: '当前查询源暂时无法连接，请稍后再试。',
    source_blocked: '当前查询源暂时无法返回结果，请稍后再试。',
    rate_limited: '请求过于频繁，请稍后再试。',
    busy: '查询服务正忙，请稍后再试。',
    proxy_required: '请通过公开入口访问查询服务。',
    origin_rejected: '当前来源未获允许，请通过公开入口访问。'
  }
  return publicMessages[body.error ?? ''] ?? '查询未完成，请稍后再试。'
}

async function requestSearch(searchQuery: string, requestedMode: SearchMode, requestedCategory: string, requestedSource: string): Promise<SearchResult> {
  const params = new URLSearchParams({
    q: searchQuery,
    mode: requestedMode,
    category: requestedCategory,
    source: requestedSource
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch('/api/search?' + params.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('服务端没有返回有效结果。')
    }
    if (!response.ok) {
      const failure = (isRecord(body) ? body : {}) as unknown as ApiErrorBody
      throw new Error(safeErrorMessage(failure))
    }
    if (!isRecord(body) || body.ok !== true) {
      const failure = (isRecord(body) ? body : {}) as unknown as ApiErrorBody
      throw new Error(safeErrorMessage(failure))
    }
    const success = body as unknown as ApiSuccessBody
    return parseResult(success.result)
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw new Error('查询超时，请稍后再试。')
    if (reason instanceof TypeError) throw new Error('暂时无法连接查询服务。')
    throw reason instanceof Error ? reason : new Error('查询未完成，请稍后再试。')
  } finally {
    clearTimeout(timeout)
  }
}

async function search() {
  const trimmed = query.value.trim()
  if (loading.value || !trimmed) {
    if (!trimmed) errorMessage.value = '请输入查询内容。'
    return
  }
  resetView()
  loading.value = true
  try {
    const filtersEnabled = mode.value !== 'fuzzy' && mode.value !== 'exact'
    result.value = await requestSearch(trimmed, mode.value,
      filtersEnabled ? category.value : 'all', filtersEnabled ? source.value : 'all')
    searched.value = true
    if (!hasResults.value) statusMessage.value = '没有找到匹配结果，请换一个关键词或调整筛选条件。'
  } catch (reason) {
    searched.value = true
    errorMessage.value = reason instanceof Error ? reason.message : '查询未完成，请稍后再试。'
  } finally {
    loading.value = false
  }
}

async function fetchExact(code: string) {
  if (loading.value) return
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    result.value = await requestSearch(code, 'exact', 'all', 'all')
    searched.value = true
    if (!visibleItems.value.length) statusMessage.value = '该条目暂时没有可复制的链接。'
  } catch (reason) {
    errorMessage.value = reason instanceof Error ? reason.message : '查询未完成，请稍后再试。'
  } finally {
    loading.value = false
  }
}

async function writeClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Fall through to the short-lived textarea fallback below.
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
  }
  return copied
}

async function copyLink(item: SearchItem) {
  clearCopyTimer()
  errorMessage.value = ''
  const copied = await writeClipboard(item.magnet)
  if (copied) {
    copiedHash.value = item.hash
    statusMessage.value = '链接已复制。'
    copyTimer = setTimeout(() => {
      copiedHash.value = ''
    }, 2_500)
  } else {
    errorMessage.value = '复制失败，请检查浏览器剪贴板权限。'
  }
}
</script>

<template>
  <main class="public-shell">
    <header class="brand-bar">
      <div class="brand-mark" aria-hidden="true">⌕</div>
      <div>
        <p class="eyebrow">NETPAN</p>
        <h1>通用搜索</h1>
      </div>
      <span class="public-badge">公开查询</span>
    </header>

    <section class="search-card" aria-labelledby="search-heading">
      <div class="card-heading">
        <div>
          <p class="eyebrow">SEARCH</p>
          <h2 id="search-heading">查找可复制的结果链接</h2>
          <p class="muted">输入名称、关键词或完整代码，系统会按所选方式查询。</p>
        </div>
      </div>

      <form class="search-form" @submit.prevent="search">
        <label class="sr-only" for="search-query">搜索内容</label>
        <div class="search-row">
          <input id="search-query" v-model="query" type="search" maxlength="80" autocomplete="off"
            placeholder="输入名称或关键词" :disabled="loading" />
          <button class="primary-button" type="submit" :disabled="loading || !query.trim()">
            {{ loading ? '查询中…' : '搜索' }}
          </button>
        </div>
        <div class="filter-row">
          <label>
            <span>匹配方式</span>
            <select v-model="mode" :disabled="loading" @change="resetView">
              <option value="auto">{{ modeLabels.auto }}</option>
              <option value="general">{{ modeLabels.general }}</option>
              <option value="fuzzy">{{ modeLabels.fuzzy }}</option>
              <option value="exact">{{ modeLabels.exact }}</option>
            </select>
          </label>
          <label>
            <span>分类</span>
            <select v-model="category" :disabled="loading || mode === 'fuzzy' || mode === 'exact'" @change="resetView">
              <option value="all">全部分类</option>
              <option value="movie">影视</option>
              <option value="tv">电视剧</option>
              <option value="book">图书</option>
              <option value="anime">动漫</option>
              <option value="learning">课程 / 学术</option>
            </select>
          </label>
          <label>
            <span>来源</span>
            <select v-model="source" :disabled="loading || mode === 'fuzzy' || mode === 'exact'" @change="resetView">
              <option value="all">全部来源</option>
              <option value="bitsearch">BitSearch</option>
              <option value="nyaa">Nyaa</option>
              <option value="academic">Academic Torrents</option>
            </select>
          </label>
        </div>
      </form>

      <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="statusMessage" class="notice success" role="status">{{ statusMessage }}</p>
      <p v-else-if="loading" class="notice loading" role="status" aria-live="polite">正在查询，请稍候…</p>

      <section v-if="result && visibleMovies.length" class="result-section" aria-labelledby="movie-heading">
        <div class="section-title">
          <div>
            <p class="eyebrow">MATCHES</p>
            <h3 id="movie-heading">匹配条目</h3>
          </div>
          <span class="count-pill">{{ visibleMovies.length }}</span>
        </div>
        <div class="movie-list">
          <article v-for="movie in visibleMovies" :key="movie.code" class="movie-card">
            <div>
              <strong>{{ movie.code }}</strong>
              <p>{{ movie.title }}</p>
            </div>
            <button class="secondary-button" type="button" :disabled="loading" @click="fetchExact(movie.code)">获取链接</button>
          </article>
        </div>
      </section>

      <section v-if="result && visibleItems.length" class="result-section" aria-labelledby="links-heading">
        <div class="section-title">
          <div>
            <p class="eyebrow">LINKS</p>
            <h3 id="links-heading">结果链接</h3>
          </div>
          <span class="count-pill">{{ visibleItems.length }}</span>
        </div>
        <div class="link-list">
          <article v-for="item in visibleItems" :key="item.hash" class="link-card">
            <div class="link-copy">
              <h4>{{ item.title }}</h4>
              <p class="metadata">
                <span v-if="item.source">{{ item.source }}</span>
                <span v-if="item.category">{{ item.category }}</span>
                <span v-if="item.size">{{ item.size }}</span>
                <span v-if="item.seeders !== undefined && item.seeders !== null">做种 {{ item.seeders }}</span>
                <span v-if="item.isHD">高清</span>
                <span v-if="item.hasSubtitle">字幕</span>
              </p>
            </div>
            <button class="secondary-button" type="button" @click="copyLink(item)">
              {{ copiedHash === item.hash ? '已复制' : '复制链接' }}
            </button>
          </article>
        </div>
      </section>

      <section v-if="result && result.sources.length" class="source-status" aria-label="来源状态">
        <p v-for="sourceStatus in result.sources" :key="sourceStatus.id" :class="sourceStatus.ok ? 'source-ok' : 'source-failed'">
          <span class="status-dot" aria-hidden="true"></span>
          {{ sourceStatus.name }}：{{ sourceStatus.ok ? `返回 ${sourceStatus.count} 条` : (sourceStatus.error || '暂时不可用') }}
        </p>
      </section>

      <div v-if="searched && result && !hasResults && !statusMessage && !errorMessage" class="empty-state">
        <span class="empty-icon" aria-hidden="true">⌕</span>
        <h3>没有匹配结果</h3>
        <p>换一个关键词或调整筛选条件后再试。</p>
      </div>
    </section>

    <footer class="page-footer">公开查询服务 · 结果仅提供链接复制</footer>
  </main>
</template>
