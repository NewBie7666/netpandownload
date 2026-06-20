import { readSealedDecisionModel } from './blackbox'
import type { DecisionBlackbox, StrictDecisionPresentation } from './types'

const summaryText = {
  ready: '可以继续处理。在线版只展示结构信息，后续步骤请在本地完成。',
  caution: '可以查看结构信息，但后续处理可能需要本地环境。',
  stop: '当前结果只适合查看，不建议继续处理。',
  unknown: '已完成基础识别，请根据列表信息决定下一步。'
} as const

const badgeText = {
  ready: '可继续',
  caution: '需谨慎',
  stop: '仅查看',
  unknown: '待判断'
} as const

export function projectStrictDecisionView(box: DecisionBlackbox): StrictDecisionPresentation {
  const model = readSealedDecisionModel(box)
  const mood = model.core.status === 'blocked'
    ? 'stop'
    : model.core.status === 'limited'
      ? 'caution'
      : model.core.status === 'ok'
        ? 'ready'
        : 'unknown'
  const signal = model.assessment.confidence >= 80
    ? '●●●●○'
    : model.assessment.confidence >= 55
      ? '●●●○○'
      : '●●○○○'
  const stepItems = model.core.canDownload
    ? model.recommendation.actionSteps
    : ['仅查看当前识别结果。', '如需继续，请更换链接或使用其他本地方案。']

  return {
    textBlocks: [
      { role: 'title', text: '解析结果' },
      { role: 'summary', text: summaryText[mood] },
      { role: 'note', text: model.recommendation.humanMessage }
    ],
    badges: [
      { text: badgeText[mood], tone: mood === 'ready' ? 'positive' : mood === 'caution' ? 'notice' : mood === 'stop' ? 'warning' : 'muted' }
    ],
    visualTokens: [
      { shape: 'dot-row', token: signal }
    ],
    sections: [
      { title: '提示', items: model.assessment.reasonCodes.map(() => '处理结果可能随资源状态变化。') },
      { title: '下一步', items: stepItems }
    ],
    buttons: model.recommendation.actionPayloads.map((payload, index) => ({
      label: payload.label,
      variant: index === 0 ? 'secondary' : 'primary',
      actionToken: payload.token
    }))
  }
}
