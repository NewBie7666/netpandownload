import type { DecisionAction, DecisionAssessment, DecisionCore, DecisionRecommendation, Tool } from './types'

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
  if (core.status === 'blocked') return '该资源当前受限，在线版不会生成下载地址。'
  if (core.platform === 'bilibili') return '在线版只展示选集信息；B站媒体地址是临时资源，建议用桌面端获取和下载。'
  if (core.platform === 'quark') return '该资源适合交给桌面端或本地下载工具处理，在线版只做解析和可行性判断。'
  return '当前只能判断资源结构，暂不建议直接下载。'
}

function commandToolFor(recommendedTool: Tool): Tool | undefined {
  return recommendedTool === 'yt-dlp' ? recommendedTool : undefined
}

export function buildRecommendation(core: DecisionCore, assessment: DecisionAssessment): DecisionRecommendation {
  const tools = toolsFor(core, assessment)
  const recommendedTool = core.canDownload ? tools[0]?.name ?? 'unsupported' : 'unsupported'

  return {
    tools,
    recommendedTool,
    action: mapAction(core, recommendedTool),
    humanMessage: buildHumanMessage(core),
    commandTool: commandToolFor(recommendedTool)
  }
}
