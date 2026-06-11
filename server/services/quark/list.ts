import { AppError } from '../../http.js'
import { quarkApi } from '../../adapters/quarkApi.js'
import type { ListResult } from '../../../shared/types.js'

export async function listQuarkFiles(
  shareId: string,
  stoken: string,
  dirFid?: string
): Promise<ListResult> {
  if (!String(shareId || '').trim() || !String(stoken || '').trim()) {
    throw new AppError('missing_session', '缺少分享会话信息，请重新获取文件列表')
  }

  return quarkApi.getShareFileList({ shareId, stoken, dirFid })
}
