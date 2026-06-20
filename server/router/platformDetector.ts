import type {
  DecisionPlatform,
  DecisionResourceType,
  DecisionRiskLevel
} from '../../shared/types.js'

export interface PlatformInference {
  normalizedUrl: string
  platform: DecisionPlatform
  resourceType: DecisionResourceType
  baseRisk: DecisionRiskLevel
  baseFeasible: boolean
  confidence: number
}

function normalizeInput(input: string) {
  const trimmed = String(input || '').trim().replace(/^['"]|['"]$/g, '')
  if (/^pan\.quark\.cn\/s\//i.test(trimmed)) return `https://${trimmed}`
  if (/^(www\.)?bilibili\.com\//i.test(trimmed)) return `https://${trimmed}`
  if (/^space\.bilibili\.com\//i.test(trimmed)) return `https://${trimmed}`
  if (/^b23\.tv\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

function fallbackInference(input: string): PlatformInference {
  return {
    normalizedUrl: normalizeInput(input),
    platform: 'unknown',
    resourceType: 'unknown',
    baseRisk: 'high',
    baseFeasible: false,
    confidence: 0.2
  }
}

export function detectPlatform(input: string): PlatformInference {
  const normalizedUrl = normalizeInput(input)
  try {
    const url = new URL(normalizedUrl)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')

    if (hostname === 'pan.quark.cn' && /^\/s\/[^/?#]+/.test(url.pathname)) {
      return {
        normalizedUrl,
        platform: 'quark',
        resourceType: 'file',
        baseRisk: 'medium',
        baseFeasible: true,
        confidence: 0.92
      }
    }

    if (hostname === 'bilibili.com' || hostname === 'b23.tv' || hostname === 'space.bilibili.com') {
      const isBangumi = /^\/bangumi\/play\//i.test(url.pathname)
      const isSpaceSearch = hostname === 'space.bilibili.com' && /^\/\d+\/search\/?$/i.test(url.pathname)
      return {
        normalizedUrl,
        platform: 'bilibili',
        resourceType: isBangumi ? 'bangumi' : isSpaceSearch ? 'playlist' : 'video',
        baseRisk: 'high',
        baseFeasible: true,
        confidence: isSpaceSearch ? 0.82 : 0.9
      }
    }

    if (['youtube.com', 'youtu.be', 'm.youtube.com'].includes(hostname)) {
      return {
        normalizedUrl,
        platform: 'youtube',
        resourceType: 'video',
        baseRisk: 'medium',
        baseFeasible: true,
        confidence: 0.78
      }
    }

    if (hostname === 'douyin.com' || hostname.endsWith('.douyin.com')) {
      return {
        normalizedUrl,
        platform: 'douyin',
        resourceType: 'video',
        baseRisk: 'high',
        baseFeasible: false,
        confidence: 0.65
      }
    }

    if (hostname === 'zhihu.com' || hostname.endsWith('.zhihu.com')) {
      return {
        normalizedUrl,
        platform: 'zhihu',
        resourceType: 'unknown',
        baseRisk: 'medium',
        baseFeasible: false,
        confidence: 0.7
      }
    }

    if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
      return {
        normalizedUrl,
        platform: 'instagram',
        resourceType: 'video',
        baseRisk: 'high',
        baseFeasible: false,
        confidence: 0.62
      }
    }
  } catch {
    return fallbackInference(input)
  }

  return fallbackInference(input)
}
