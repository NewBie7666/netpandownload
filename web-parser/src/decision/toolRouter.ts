import type { DecisionAction, DecisionAssessment, DecisionCore, DecisionRecommendation, OpaqueActionToken, Tool } from './types'

export const OPAQUE_ACTIONS = {
  copySource: 'oa_01' as OpaqueActionToken,
  openDesktop: 'oa_02' as OpaqueActionToken,
  copyCommand: 'oa_03' as OpaqueActionToken
} as const

function toolsFor(core: DecisionCore, assessment: DecisionAssessment): DecisionRecommendation['tools'] {
  if (core.platform === 'bilibili') {
    return [
      { name: 'desktop-app', confidence: Math.max(65, assessment.confidence) },
      { name: 'yt-dlp', confidence: Math.max(60, assessment.confidence - 5) }
    ]
  }

  if (core.platform === 'quark') {
    return [
      { name: 'desktop-app', confidence: assessment.confidence },
      { name: 'aria2', confidence: Math.max(70, assessment.confidence - 5) },
      { name: 'idm', confidence: Math.max(65, assessment.confidence - 10) }
    ]
  }

  return [{ name: 'unsupported', confidence: 0 }]
}

function mapAction(core: DecisionCore, recommendedTool: Tool): DecisionAction {
  if (!core.canDownload) return 'unsupported'
  if (recommendedTool === 'desktop-app') return 'use_desktop'
  if (recommendedTool === 'yt-dlp' || recommendedTool === 'aria2' || recommendedTool === 'idm') return 'open_tool'
  if (recommendedTool === 'browser') return 'copy_url'
  return 'unsupported'
}

function buildHumanMessage(core: DecisionCore) {
  if (core.status === 'blocked') return '当前结果只适合查看，不建议继续下载。'
  if (core.platform === 'bilibili') return '在线版只展示选集信息，实际获取请在本地完成。'
  if (core.platform === 'quark') return '该资源适合交给本地客户端继续处理。'
  return '当前只提供识别结果，请使用支持该来源的本地工具继续处理。'
}

function actionStepsFor(action: DecisionAction) {
  const steps: Record<DecisionAction, readonly string[]> = {
    use_desktop: ['复制当前链接。', '打开本地客户端。', '在本地继续解析和处理。'],
    open_tool: ['复制当前链接。', '打开合适的本地工具。', '粘贴链接后继续处理。'],
    copy_url: ['复制当前链接。', '粘贴到支持该来源的工具中继续处理。'],
    unsupported: ['当前在线版只提供资源识别结果。', '请更换链接，或使用支持该来源的本地工具。']
  }
  return steps[action]
}

function actionPayloadsFor(action: DecisionAction, recommendedTool: Tool): DecisionRecommendation['actionPayloads'] {
  if (action === 'unsupported') return []

  const payloads: Array<DecisionRecommendation['actionPayloads'][number]> = [
    { label: '复制链接', token: OPAQUE_ACTIONS.copySource }
  ]

  if (action === 'use_desktop') {
    payloads.push({ label: '打开本地客户端', token: OPAQUE_ACTIONS.openDesktop })
  }

  if (recommendedTool === 'yt-dlp') {
    payloads.push({ label: '复制参考命令', token: OPAQUE_ACTIONS.copyCommand })
  }

  return payloads
}

export function buildRecommendation(core: DecisionCore, assessment: DecisionAssessment): DecisionRecommendation {
  const tools = toolsFor(core, assessment)
  const recommendedTool = core.canDownload ? tools[0]?.name ?? 'unsupported' : 'unsupported'
  const action = mapAction(core, recommendedTool)

  return {
    tools,
    recommendedTool,
    action,
    humanMessage: buildHumanMessage(core),
    actionSteps: actionStepsFor(action),
    actionPayloads: actionPayloadsFor(action, recommendedTool)
  }
}
