import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../http.js'

export interface SafeDownloadFile {
  absolutePath: string
  name: string
  size: number
}

/** Only serve completed aria2 files physically contained in our download directory. */
export async function resolveSafeDownloadFile(root: string, file: string): Promise<SafeDownloadFile> {
  if (!file || !path.isAbsolute(file)) {
    throw new AppError('download_file_missing', '下载文件路径无效', 404)
  }
  let canonicalRoot: string
  let canonicalFile: string
  try {
    ;[canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)])
  } catch {
    throw new AppError('download_file_missing', '下载文件已不存在', 404)
  }
  const relative = path.relative(canonicalRoot, canonicalFile)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new AppError('download_file_forbidden', '不允许从下载目录以外传输文件', 403)
  }
  const fileInfo = await stat(canonicalFile)
  if (!fileInfo.isFile()) {
    throw new AppError('download_file_forbidden', '只能下载普通文件', 403)
  }
  const name = path.basename(canonicalFile)
  return { absolutePath: canonicalFile, name, size: fileInfo.size }
}
