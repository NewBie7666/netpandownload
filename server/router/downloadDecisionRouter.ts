import { Router } from 'express'
import type {
  DecisionAction,
  DecisionRecommendedTool,
  DecisionResourceType,
  DownloadDecision
} from '../../shared/types.js'
import { fail, ok } from '../http.js'
import { detectPlatform, type PlatformInference } from './platformDetector.js'

type ParserMode = 'local' | 'remote' | 'hybrid'

interface WebParseLike {
  providerId?: string
  files?: Array<{ type?: string; status?: string; urlType?: string }>
  warnings?: string[]
}

export const downloadDecisionRouter = Router()

function getParserMode(): ParserMode {
  const value = String(process.env.DECISION_PARSER_MODE || 'hybrid').toLowerCase()
  return value === 'local' || value === 'remote' || value === 'hybrid' ? value : 'hybrid'
}

function getWebParserBaseUrl() {
  return String(process.env.WEB_PARSER_BASE_URL || 'http://127.0.0.1:5190').replace(/\/+$/, '')
}

async function tryLocalParse(url: string): Promise<WebParseLike | undefined> {
  const mod = await import('../../web-parser/server/parser.js')
  return mod.parseWebLink(url)
}

async function tryRemoteParse(url: string): Promise<WebParseLike | undefined> {
  const response = await fetch(`${getWebParserBaseUrl()}/api/web/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: url }),
    signal: AbortSignal.timeout(3500)
  })
  if (!response.ok) return undefined
  const payload = await response.json() as { ok?: boolean; result?: WebParseLike }
  return payload.ok ? payload.result : undefined
}

async function enrichWithWebParser(url: string) {
  const mode = getParserMode()
  try {
    if (mode === 'local') return await tryLocalParse(url)
    if (mode === 'remote') return await tryRemoteParse(url)
    return await tryLocalParse(url) || await tryRemoteParse(url)
  } catch {
    if (mode === 'hybrid') {
      try {
        return await tryRemoteParse(url)
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function decideTool(inference: PlatformInference): DecisionRecommendedTool {
  if (inference.platform === 'bilibili') {
    return { type: 'desktop', name: 'desktop-downloader', capability: 'video-extract' }
  }
  if (inference.platform === 'quark') {
    return { type: 'desktop', name: 'desktop-downloader', capability: 'multi-thread-download' }
  }
  if (inference.platform === 'youtube') {
    return { type: 'local-tool', name: 'external-downloader', capability: 'video-extract' }
  }
  return { type: 'none', name: 'not-supported', capability: 'unsupported' }
}

function decideAction(inference: PlatformInference): DecisionAction {
  if (inference.platform === 'bilibili' || inference.platform === 'quark') return 'use_desktop_downloader'
  if (inference.platform === 'youtube') return 'use_local_tool'
  return 'unsupported'
}

function refineResourceType(inference: PlatformInference, parsed?: WebParseLike): DecisionResourceType {
  if (!parsed?.files?.length) return inference.resourceType
  if (inference.platform === 'bilibili' && parsed.files.length > 1) return 'playlist'
  if (inference.platform === 'quark') return parsed.files.some((file) => file.type === 'folder') ? 'file' : 'file'
  return inference.resourceType
}

function buildExplanation(inference: PlatformInference, parsed?: WebParseLike) {
  const enriched = parsed ? '已结合在线解析 metadata。' : '在线解析增强不可用，已使用本地规则判断。'
  if (inference.platform === 'bilibili') {
    return `${enriched} B站媒体地址通常是临时资源，建议继续使用桌面端完成登录、解析和下载。`
  }
  if (inference.platform === 'quark') {
    return `${enriched} 夸克资源建议使用桌面端内置下载器或多线程下载能力处理。`
  }
  if (inference.platform === 'youtube') {
    return `${enriched} 当前桌面端未内置 YouTube Provider，可使用本机外部下载工具处理。`
  }
  if (inference.platform === 'douyin' || inference.platform === 'zhihu' || inference.platform === 'instagram') {
    return `${enriched} 当前版本只识别该平台，不提供下载执行能力。`
  }
  return '当前链接来源无法识别，暂不支持。'
}

export async function resolveDownloadDecision(url: string): Promise<DownloadDecision> {
  const inference = detectPlatform(url)
  const parsed = inference.platform === 'unknown' ? undefined : await enrichWithWebParser(inference.normalizedUrl)
  const feasible = inference.baseFeasible && inference.platform !== 'unknown'
  const confidence = Math.min(1, Math.max(0, parsed ? inference.confidence + 0.05 : inference.confidence))

  return {
    platform: inference.platform,
    feasible,
    riskLevel: inference.baseRisk,
    resourceType: refineResourceType(inference, parsed),
    recommendedTool: decideTool(inference),
    action: decideAction(inference),
    confidence,
    explanation: buildExplanation(inference, parsed)
  }
}

downloadDecisionRouter.post('/resolve', async (req, res) => {
  const url = String(req.body?.url || '').trim()
  if (!url) {
    res.status(400).json(fail('invalid_url', '请输入需要判断的链接'))
    return
  }
  res.json(ok(await resolveDownloadDecision(url)))
})
