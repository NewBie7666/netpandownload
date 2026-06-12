import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadSettingsResult } from '../../shared/types.js'
import { AppError } from '../http.js'

interface DownloadSettingsFile {
  downloadDir?: string
}

function getSettingsDir() {
  const desktopDataDir = String(process.env.NETPAN_DATA_DIR || '').trim()
  return desktopDataDir || path.resolve(process.cwd(), 'data')
}

function getSettingsPath() {
  return path.join(getSettingsDir(), 'settings.json')
}

async function readSettingsFile(): Promise<DownloadSettingsFile> {
  try {
    const content = await readFile(getSettingsPath(), 'utf8')
    const parsed = JSON.parse(content) as DownloadSettingsFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw new AppError('settings_read_failed', '读取下载设置失败')
  }
}

async function writeSettingsFile(settings: DownloadSettingsFile) {
  await mkdir(getSettingsDir(), { recursive: true })
  await writeFile(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

export async function getConfiguredDownloadDir(defaultDownloadDir: string) {
  const settings = await readSettingsFile()
  const downloadDir = String(settings.downloadDir || '').trim()
  return downloadDir || defaultDownloadDir
}

export async function getDownloadSettings(defaultDownloadDir: string): Promise<DownloadSettingsResult> {
  return {
    downloadDir: await getConfiguredDownloadDir(defaultDownloadDir),
    defaultDownloadDir
  }
}

export async function saveDownloadSettings(
  input: { downloadDir?: string },
  defaultDownloadDir: string
): Promise<DownloadSettingsResult> {
  const rawDownloadDir = String(input.downloadDir || '').trim()
  if (!rawDownloadDir) {
    throw new AppError('invalid_download_dir', '下载目录不能为空')
  }

  const resolvedDownloadDir = path.resolve(rawDownloadDir)
  if (!path.isAbsolute(resolvedDownloadDir)) {
    throw new AppError('invalid_download_dir', '下载目录必须是绝对路径')
  }

  try {
    await mkdir(resolvedDownloadDir, { recursive: true })
    await writeSettingsFile({ downloadDir: resolvedDownloadDir })
  } catch (error) {
    if (error instanceof AppError) {
      throw error
    }
    throw new AppError('download_dir_create_failed', '创建或保存下载目录失败')
  }

  return {
    downloadDir: resolvedDownloadDir,
    defaultDownloadDir
  }
}
