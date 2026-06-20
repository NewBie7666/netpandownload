import type { DecisionAction, DecisionModel, DecisionViewModel, Tool } from './types'

const platformLabel: Record<DecisionModel['core']['platform'], string> = {
  bilibili: 'B站资源',
  quark: '夸克资源',
  youtube: 'YouTube 资源',
  douyin: '抖音资源',
  zhihu: '知乎资源',
  instagram: 'Instagram 资源',
  unknown: '未知资源'
}

const statusText: Record<DecisionModel['core']['status'], string> = {
  ok: '可以下载',
  limited: '可能受限制',
  blocked: '暂不可用',
  unknown: '无法判断'
}

const riskText: Record<DecisionModel['assessment']['risk'], string> = {
  low: '低',
  medium: '中',
  high: '高'
}

const toolText: Record<Tool, string> = {
  'desktop-app': '桌面端',
  'yt-dlp': 'yt-dlp',
  aria2: 'aria2',
  idm: 'IDM',
  browser: '浏览器',
  unsupported: '暂不支持'
}

const reasonText: Record<string, string> = {
  available_file: '资源结构可识别',
  blocked_resource: '资源当前受限',
  desktop_required: '建议使用桌面端',
  local_downloader_recommended: '适合本地下载工具',
  login_may_required: '登录可能提升成功率',
  metadata_only: '在线版只展示元信息',
  restricted_resource: '可能需要权限或登录',
  temporary_link_possible: '直链可能会过期',
  temporary_media: '媒体地址为临时资源',
  unsupported: '暂未支持该来源'
}

const actionSteps: Record<DecisionAction, readonly string[]> = {
  use_desktop: ['复制当前链接。', '打开桌面端。', '在桌面端解析并下载。'],
  open_tool: ['复制当前链接。', '打开推荐的本机工具。', '粘贴链接后继续处理。'],
  copy_url: ['复制当前链接。', '粘贴到支持该资源的工具中继续处理。'],
  unsupported: ['当前在线版只提供资源识别结果。', '请更换链接，或使用支持该平台的本机工具。']
}

function buildCopyCommand(commandTool: Tool | undefined, sourceUrl: string) {
  if (!commandTool) return undefined
  const cleanUrl = sourceUrl.trim()
  if (!cleanUrl) return undefined
  return `${commandTool} "${cleanUrl.replace(/"/g, '\\"')}"`
}

export function toDecisionViewModel(model: DecisionModel, sourceUrl: string): DecisionViewModel {
  const cleanUrl = sourceUrl.trim()
  const canUseUrl = Boolean(cleanUrl)

  return {
    platformLabel: platformLabel[model.core.platform],
    status: model.core.status,
    statusText: statusText[model.core.status],
    risk: model.assessment.risk,
    riskText: riskText[model.assessment.risk],
    successPercent: model.assessment.confidence,
    humanMessage: model.recommendation.humanMessage,
    reasonTags: model.assessment.reasonCodes.map((code) => reasonText[code] || code),
    toolLabels: model.recommendation.tools.map((tool) => toolText[tool.name]).join(' / '),
    actionSteps: actionSteps[model.recommendation.action],
    actions: {
      copyUrl: canUseUrl && model.recommendation.action !== 'unsupported',
      openDesktop: canUseUrl && model.recommendation.action === 'use_desktop',
      copyCommand: buildCopyCommand(model.recommendation.commandTool, cleanUrl)
    }
  }
}
