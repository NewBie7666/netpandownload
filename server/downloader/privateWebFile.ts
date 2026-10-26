import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { AppError } from '../http.js'

export interface SafeDownloadFile {
  absolutePath: string
  name: string
  size: number
  device: number
  inode: number
}

export interface OpenSafeDownloadFile extends SafeDownloadFile {
  handle: FileHandle
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
  return { absolutePath: canonicalFile, name, size: fileInfo.size, device: fileInfo.dev, inode: fileInfo.ino }
}

/** Open the validated file and stream through the descriptor to avoid a path/symlink race. */
export async function openSafeDownloadFile(root: string, file: string): Promise<OpenSafeDownloadFile> {
  const safe = await resolveSafeDownloadFile(root, file)
  let handle: FileHandle | undefined
  try {
    handle = await open(safe.absolutePath, constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NOFOLLOW : 0))
    const opened = await handle.stat()
    const currentPath = await realpath(safe.absolutePath)
    const descriptorPath = process.platform === 'linux' ? await realpath(`/proc/self/fd/${handle.fd}`) : currentPath
    if (!opened.isFile() || opened.size !== safe.size || opened.dev !== safe.device || opened.ino !== safe.inode || currentPath !== safe.absolutePath || descriptorPath !== safe.absolutePath) {
      await handle.close()
      throw new AppError('download_file_changed', '下载文件在校验后发生变化，请稍后重试', 409)
    }
  } catch (error) {
    try { await handle?.close() } catch { /* best effort */ }
    if (error instanceof AppError) throw error
    throw new AppError('download_file_missing', '下载文件已不存在', 404)
  }
  if (!handle) throw new AppError('download_file_missing', '下载文件已不存在', 404)
  return { ...safe, handle }
}
