import { AppError } from '../../server/http.js'

export const webParserMode = 'PURE_PARSER' as const

export function assertPureParserMode() {
  if (webParserMode !== 'PURE_PARSER') {
    throw new AppError('web_parser_mode_invalid', '在线解析版只允许运行 PURE_PARSER 模式', 500)
  }
}

export function rejectPublicMediaResolve() {
  throw new AppError(
    'media_resolver_disabled',
    '公网在线解析版不生成视频直链。请使用桌面版或受保护的私有解析服务。',
    403
  )
}
