import { lstat, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../http.js'

function withinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath)
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code))
}

/**
 * Validate the exact file paths returned by aria2 before stopping a task.
 * We do not delete parent directories. Realpath checks block paths escaping
 * the selected download directory via Windows junctions or symbolic links.
 */
export async function prepareTaskFileDeletion(files: string[], allowedDirectories: string[]): Promise<string[]> {
  const allowedRoots = await Promise.all(allowedDirectories.map(async directory => {
    try { return await realpath(directory) } catch { return path.resolve(directory) }
  }))
  const seen = new Set<string>()
  const validated: string[] = []

  async function includeFile(filePath: string) {
    const raw = filePath.trim()
    if (!raw) return
    if (!path.isAbsolute(raw)) {
      throw new AppError('download_file_delete_forbidden', '下载文件路径不是绝对路径，已拒绝删除', 403)
    }
    const resolved = path.resolve(raw)
    if (!allowedDirectories.some(root => withinDirectory(resolved, path.resolve(root)))) {
      throw new AppError('download_file_delete_forbidden', '只允许删除已配置下载目录内的任务文件', 403)
    }
    if (seen.has(resolved)) return
    let file
    try { file = await lstat(resolved) } catch (error) {
      if (isMissing(error)) return // File has not been created yet.
      throw error
    }
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new AppError('download_file_delete_forbidden', '拒绝删除目录、符号链接或非普通文件', 403)
    }
    const canonicalParent = await realpath(path.dirname(resolved))
    if (!allowedRoots.some(root => withinDirectory(canonicalParent, root) || canonicalParent === root)) {
      throw new AppError('download_file_delete_forbidden', '文件真实路径超出下载目录，已拒绝删除', 403)
    }
    seen.add(resolved)
    validated.push(resolved)
  }

  for (const filePath of files) {
    await includeFile(filePath)
    if (filePath.trim() && !filePath.toLowerCase().endsWith('.aria2')) {
      // aria2 writes partial transfer control files next to the payload.
      await includeFile(filePath + '.aria2')
    }
  }
  return validated
}

/** aria2 must be stopped/removed before calling this on Windows. */
export async function deletePreparedTaskFiles(paths: string[]): Promise<number> {
  let removed = 0
  for (const filePath of paths) {
    let lastError: unknown
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        const status = await lstat(filePath)
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new AppError('download_file_delete_forbidden', '文件类型已变更，拒绝删除', 403)
        }
        await rm(filePath, { force: false })
        removed++
        lastError = undefined
        break
      } catch (error) {
        if (isMissing(error)) { lastError = undefined; break }
        if (error instanceof AppError || !isRetryable(error) || attempt === 15) {
          lastError = error
          break
        }
        lastError = error
        await sleep(250)
      }
    }
    if (lastError) {
      throw new AppError('download_file_delete_failed', '部分下载文件仍被占用或没有删除权限，请在下载目录中手动清理')
    }
  }
  return removed
}
