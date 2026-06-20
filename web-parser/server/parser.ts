import { AppError } from '../../server/http.js'
import { fetchBilibiliInitialState, expandBilibiliShortUrl } from '../../server/providers/bilibili/access/index.js'
import { resolveShare as resolveBilibiliShare, isBilibiliUrl } from '../../server/providers/bilibili/resolver/index.js'
import { quarkProvider } from '../../server/providers/quarkProvider.js'
import type { QuarkFile } from '../../shared/types.js'
import type { WebParsedFile, WebParseResult } from './types.js'

function normalizeInput(input: string) {
  const trimmed = String(input || '').trim()
  if (/^pan\.quark\.cn\/s\//i.test(trimmed)) return `https://${trimmed}`
  if (/^(www\.)?bilibili\.com\//i.test(trimmed)) return `https://${trimmed}`
  if (/^space\.bilibili\.com\//i.test(trimmed)) return `https://${trimmed}`
  if (/^b23\.tv\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

function isQuarkUrl(input: string) {
  try {
    const url = new URL(normalizeInput(input))
    return /^pan\.quark\.cn$/i.test(url.hostname) && /^\/s\/[^/?#]+/.test(url.pathname)
  } catch {
    return false
  }
}

function quarkFileToWebFile(file: QuarkFile): WebParsedFile {
  return {
    id: file.fid,
    name: file.name,
    type: file.isDir ? 'folder' : 'file',
    size: file.size,
    status: 'available',
    hint: file.isDir ? '可继续进入目录解析' : '可在桌面版或本地下载工具中处理',
    urlType: 'none'
  }
}

function biliFileToWebFile(file: QuarkFile): WebParsedFile {
  return {
    id: file.fid,
    name: file.name,
    type: 'episode',
    size: file.size,
    status: 'temporary',
    hint: '在线版只展示选集信息；B站媒体地址是临时资源，请使用桌面版获取和下载。',
    urlType: 'requires_cookie'
  }
}

export async function parseWebLink(input: string, passcode = ''): Promise<WebParseResult> {
  const normalized = normalizeInput(input)

  if (isQuarkUrl(normalized)) {
    const response = await quarkProvider.resolveShare({ shareUrl: normalized, passcode })
    if (!response.ok || response.kind !== 'success') {
      throw new AppError(response.error?.code || 'quark_parse_failed', response.error?.message || '夸克链接解析失败')
    }
    return {
      providerId: 'quark',
      title: '夸克分享',
      mode: 'PURE_PARSER',
      files: response.data.files.map(quarkFileToWebFile),
      warnings: ['在线版只做解析，不接入云端下载器。']
    }
  }

  if (isBilibiliUrl(normalized)) {
    const resolved = await resolveBilibiliShare(normalized, {
      fetchInitialStateJson: fetchBilibiliInitialState,
      expandShortUrl: expandBilibiliShortUrl
    })
    return {
      providerId: 'bilibili',
      title: 'B站资源',
      mode: 'PURE_PARSER',
      files: resolved.files.map(biliFileToWebFile),
      warnings: [
        '公网在线版不执行 yt-dlp，也不生成 B站临时媒体直链。',
        'B站资源如需下载，请使用桌面版或受保护的私有解析服务。'
      ]
    }
  }

  throw new AppError('unsupported_provider', '当前只支持夸克分享链接和 B站链接')
}
