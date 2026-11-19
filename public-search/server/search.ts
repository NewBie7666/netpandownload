import { AppError } from '../../server/http.js'
import { normalizeVideoCode, searchByCode, type SearchTransport } from '../../server/search-core/codeSearch.js'
import { normalizeMagnetKeyword, searchByKeyword } from '../../server/search-core/keywordSearch.js'
import { normalizeGeneralCategory, normalizeGeneralSource, searchGeneralMagnets } from '../../server/search-core/generalSearch.js'
import { publicTransport } from './network.js'

export function validateQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some(key => !['q', 'mode', 'category', 'source'].includes(key))) {
    throw new AppError('invalid_query', '搜索参数不正确')
  }
  const mode = query.mode ?? 'auto'
  if (!['auto', 'general', 'fuzzy', 'exact'].includes(mode as string)) throw new AppError('invalid_mode', '请选择有效的匹配方式')
  const q = mode === 'exact' ? normalizeVideoCode(query.q) : normalizeMagnetKeyword(query.q)
  return { q, mode, category: normalizeGeneralCategory(query.category), source: normalizeGeneralSource(query.source) }
}

export async function runSearch(params: ReturnType<typeof validateQuery>, transport: SearchTransport = publicTransport) {
  let { mode } = params
  const { q, category, source } = params
  if (mode === 'auto') {
    try { normalizeVideoCode(q); mode = 'exact' } catch { /* Query general sources and fuzzy index together. */ }
  }
  if (mode === 'exact') {
    const result = await searchByCode(q, transport)
    // Rebuild links from validated hashes; upstream tracker parameters cannot expose credentials.
    return { query: q, items: result.items.slice(0, 60).map(item => ({ ...item,
      magnet: 'magnet:?xt=urn:btih:' + item.hash + '&dn=' + encodeURIComponent(item.title)
    })), movies: [], sources: [{ id: 'catalog', name: '匹配索引', ok: true, count: result.items.length }] }
  }
  if (mode === 'fuzzy') {
    const result = await searchByKeyword(q, transport)
    return { query: q, items: [], movies: result.movies,
      sources: [{ id: 'catalog', name: '匹配索引', ok: true, count: result.movies.length }] }
  }
  const general = searchGeneralMagnets(q, category, source, transport)
  const outcomes = await Promise.allSettled(mode === 'general' ? [general] : [general, searchByKeyword(q, transport)])
  if (outcomes.every(outcome => outcome.status === 'rejected')) {
    throw new AppError('sources_unavailable', '搜索源暂时不可用，请稍后重试', 502)
  }
  const g = outcomes[0]
  const f = outcomes[1]
  const generalResult = g.status === 'fulfilled' ? g.value as Awaited<typeof general> : null
  const fuzzyResult = f?.status === 'fulfilled' ? f.value as Awaited<ReturnType<typeof searchByKeyword>> : null
  return { query: q, items: generalResult?.items || [], movies: fuzzyResult?.movies || [],
    sources: [
      ...(generalResult?.sources.map(status => ({ ...status, error: status.ok ? undefined : '搜索源暂时不可用' })) ||
        [{ id: 'general', name: '通用索引', ok: false, count: 0, error: '搜索源暂时不可用' }]),
      ...(f ? [{ id: 'catalog', name: '匹配索引', ok: f.status === 'fulfilled', count: fuzzyResult?.movies.length || 0,
        error: f.status === 'fulfilled' ? undefined : '搜索源暂时不可用' }] : [])
    ] }
}
