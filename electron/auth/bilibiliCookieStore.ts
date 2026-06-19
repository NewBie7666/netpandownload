import { app, safeStorage, type Cookie } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const cookieOrder = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']
const storeFileName = 'bilibili-cookie.bin'

export interface StoredBilibiliCookie {
  cookie: string
  lastLoginTime: number
}

function getStorePath() {
  return path.join(app.getPath('userData'), storeFileName)
}

function normalizeCookieDomain(domain = '') {
  return domain.replace(/^\./, '').toLowerCase()
}

function isBilibiliCookie(cookie: Cookie) {
  return normalizeCookieDomain(cookie.domain).endsWith('bilibili.com')
}

function encryptString(value: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage is not available')
  }
  return safeStorage.encryptString(value)
}

function decryptString(buffer: Buffer) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage is not available')
  }
  return safeStorage.decryptString(buffer)
}

export function isValidBilibiliCookie(cookie: string) {
  return /\bSESSDATA=/.test(cookie) && /\bDedeUserID=/.test(cookie)
}

export function formatBilibiliCookie(cookies: Cookie[]) {
  const values = new Map<string, string>()

  for (const cookie of cookies) {
    if (!isBilibiliCookie(cookie) || !cookieOrder.includes(cookie.name)) {
      continue
    }
    values.set(cookie.name, cookie.value)
  }

  return cookieOrder
    .filter((name) => values.has(name))
    .map((name) => `${name}=${values.get(name)}`)
    .join('; ')
}

export async function saveBilibiliCookie(cookie: string) {
  if (!isValidBilibiliCookie(cookie)) {
    throw new Error('Bilibili cookie is incomplete')
  }

  const payload: StoredBilibiliCookie = {
    cookie,
    lastLoginTime: Date.now()
  }
  const filePath = getStorePath()
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, encryptString(JSON.stringify(payload)))
  return payload
}

export async function loadBilibiliCookie(): Promise<StoredBilibiliCookie | null> {
  try {
    const filePath = getStorePath()
    const buffer = await readFile(filePath)
    const payload = JSON.parse(decryptString(buffer)) as StoredBilibiliCookie
    if (!payload?.cookie || !isValidBilibiliCookie(payload.cookie)) {
      await clearBilibiliCookieStore()
      return null
    }
    return payload
  } catch {
    await clearBilibiliCookieStore()
    return null
  }
}

export async function clearBilibiliCookieStore() {
  await rm(getStorePath(), { force: true })
}
