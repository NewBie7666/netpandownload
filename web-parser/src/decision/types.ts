export type Platform = 'bilibili' | 'quark' | 'youtube' | 'douyin' | 'zhihu' | 'instagram' | 'unknown'
export type ResourceType = 'video' | 'playlist' | 'bangumi' | 'file' | 'folder' | 'unknown'
export type DecisionStatus = 'ok' | 'limited' | 'blocked' | 'unknown'
export type RiskLevel = 'low' | 'medium' | 'high'
export type Tool = 'yt-dlp' | 'aria2' | 'idm' | 'desktop-app' | 'browser' | 'unsupported'
export type DecisionAction = 'use_desktop' | 'copy_url' | 'open_tool' | 'unsupported'

export interface PlatformFacts {
  readonly platform: Platform
  readonly resourceType: ResourceType
  readonly hasAvailable: boolean
  readonly hasTemporary: boolean
  readonly hasRestricted: boolean
  readonly hasBlocked: boolean
  readonly hasFiles: boolean
}

export interface DecisionCore {
  readonly platform: Platform
  readonly resourceType: ResourceType
  readonly status: DecisionStatus
  readonly canDownload: boolean
}

export interface DecisionAssessment {
  readonly risk: RiskLevel
  readonly confidence: number
  readonly reasonCodes: readonly string[]
}

export interface DecisionRecommendation {
  readonly tools: readonly {
    readonly name: Tool
    readonly confidence: number
  }[]
  readonly recommendedTool: Tool
  readonly action: DecisionAction
  readonly humanMessage: string
  readonly commandTool?: Tool
}

export interface DecisionModel {
  readonly core: DecisionCore
  readonly assessment: DecisionAssessment
  readonly recommendation: DecisionRecommendation
}

export interface DecisionViewModel {
  readonly platformLabel: string
  readonly status: DecisionStatus
  readonly statusText: string
  readonly risk: RiskLevel
  readonly riskText: string
  readonly successPercent: number
  readonly humanMessage: string
  readonly reasonTags: readonly string[]
  readonly toolLabels: string
  readonly actionSteps: readonly string[]
  readonly actions: {
    readonly copyUrl: boolean
    readonly openDesktop: boolean
    readonly copyCommand?: string
  }
}
