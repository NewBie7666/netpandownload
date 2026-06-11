import { quarkApi } from '../../adapters/quarkApi.js'
import type { ShareResult } from '../../../shared/types.js'

export async function getShareFiles(shareUrl: string, passcode = ''): Promise<ShareResult> {
  const parsed = quarkApi.parseShareUrl(shareUrl)
  const token = await quarkApi.getShareToken(parsed.shareId, passcode || parsed.passcode)
  const data = await quarkApi.getShareFileList({
    shareId: parsed.shareId,
    stoken: token,
    dirFid: parsed.dirFid
  })

  return {
    shareId: parsed.shareId,
    stoken: token,
    path: parsed.dirFid ? [{ fid: parsed.dirFid, name: '分享目录' }] : [],
    files: data.files
  }
}
