export type Frozen<T> = Readonly<T>

export type Platform = 'bilibili' | 'quark' | 'youtube' | 'douyin' | 'zhihu' | 'instagram' | 'unknown'
export type ResourceType = 'video' | 'playlist' | 'bangumi' | 'file' | 'folder' | 'unknown'
export type DecisionStatus = 'ok' | 'limited' | 'blocked' | 'unknown'
export type RiskLevel = 'low' | 'medium' | 'high'
export type Tool = 'yt-dlp' | 'aria2' | 'idm' | 'desktop-app' | 'browser' | 'unsupported'
export type DecisionAction = 'use_desktop' | 'copy_url' | 'open_tool' | 'unsupported'
export type OpaqueActionToken = string & { readonly __opaqueActionToken: unique symbol }

export interface PlatformFacts {
  readonly platform: Platform
  readonly resourceType: ResourceType
  readonly hasAvailable: boolean
  readonly hasTemporary: boolean
  readonly hasRestricted: boolean
  readonly hasBlocked: boolean
  readonly hasFiles: boolean
}

export type DecisionCore = Frozen<{
  platform: Platform
  resourceType: ResourceType
  status: DecisionStatus
  canDownload: boolean
}>

export type DecisionAssessment = Frozen<{
  risk: RiskLevel
  confidence: number
  reasonCodes: readonly string[]
}>

export type DecisionActionPayload = Frozen<{
  label: string
  token: OpaqueActionToken
}>

export type DecisionRecommendation = Frozen<{
  tools: readonly Frozen<{
    name: Tool
    confidence: number
  }>[]
  recommendedTool: Tool
  action: DecisionAction
  humanMessage: string
  actionSteps: readonly string[]
  actionPayloads: readonly DecisionActionPayload[]
}>

/**
 * SEMANTIC CONTRACT (DO NOT INTERPRET IN UI)
 *
 * This model is NOT a UI model.
 * It is NOT a recommendation engine output.
 * It is a frozen decision artifact.
 */
export type DecisionModel = Frozen<{
  core: DecisionCore
  assessment: DecisionAssessment
  recommendation: DecisionRecommendation
}>

export type DecisionButtonView = Frozen<{
  label: string
  variant: 'primary' | 'secondary'
  actionToken: OpaqueActionToken
}>

export type DecisionViewModel = Frozen<{
  textBlocks: readonly Frozen<{
    role: 'title' | 'summary' | 'note'
    text: string
  }>[]
  badges: readonly Frozen<{
    text: string
    tone: 'positive' | 'notice' | 'warning' | 'muted'
  }>[]
  visualTokens: readonly Frozen<{
    shape: 'bar' | 'dot-row' | 'icon'
    token: string
  }>[]
  sections: readonly Frozen<{
    title: string
    items: readonly string[]
  }>[]
  buttons: readonly DecisionButtonView[]
}>

export type StrictDecisionPresentation = Frozen<{
  textBlocks: DecisionViewModel['textBlocks']
  badges: DecisionViewModel['badges']
  visualTokens: DecisionViewModel['visualTokens']
  sections: DecisionViewModel['sections']
  buttons: DecisionViewModel['buttons']
}>

export interface DecisionBlackbox {
  readonly __decisionBlackbox: unique symbol
}

export type OpaqueActionContext = {
  readonly url: string
  readonly copyText: (value: string, message: string) => void | Promise<void>
  readonly openUrl: (value: string) => void
}
