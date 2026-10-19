import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'

export function aria2SessionPath(userDataDir: string): string {
  return path.join(userDataDir, 'aria2', 'downloads.session')
}

export async function ensureAria2SessionFile(sessionPath: string): Promise<void> {
  await mkdir(path.dirname(sessionPath), { recursive: true })
  const file = await open(sessionPath, 'a')
  await file.close()
}

export function aria2SessionArgs(sessionPath: string): string[] {
  return [
    '--input-file=' + sessionPath,
    '--save-session=' + sessionPath,
    '--save-session-interval=10',
    '--auto-save-interval=10',
    '--force-save=false'
  ]
}
