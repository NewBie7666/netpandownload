import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clearDouyinTemporaryCredentials,
  managedDouyinCookieHeader,
  withDouyinCookieFile
} from '../../server/auth/douyin/credentials.js'
import { getDefaultDouyinStore } from '../../server/auth/douyin/sessionStore.js'
import type { DouyinCookie } from '../../server/auth/douyin/types.js'

const DAY_SECONDS = 24 * 60 * 60
const FIXTURE_VALUE = 'fixture-session-value-0123456789'
const FIXTURE_BASE = 1_900_000_000

function cookie(overrides: Partial<DouyinCookie> = {}): DouyinCookie {
  return {
    name: 'sessionid',
    value: FIXTURE_VALUE,
    domain: '.douyin.com',
    path: '/',
    expires: Math.floor(Date.now() / 1000) + DAY_SECONDS,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides
  }
}

async function withDataDir<T>(callback: (dataDir: string) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'netpan-douyin-credentials-'))
  const previous = process.env.NETPAN_DATA_DIR
  process.env.NETPAN_DATA_DIR = dataDir
  try {
    return await callback(dataDir)
  } finally {
    if (previous === undefined) delete process.env.NETPAN_DATA_DIR
    else process.env.NETPAN_DATA_DIR = previous
    await rm(dataDir, { recursive: true, force: true })
  }
}

function cookieDirectory(dataDir: string): string {
  return path.join(dataDir, 'auth', 'douyin', 'tmp')
}

test('absent managed auth returns undefined and preserves the legacy path', async () => {
  await withDataDir(async () => {
    const url = new URL('https://www.douyin.com/video/fixture')
    assert.equal(await managedDouyinCookieHeader(url), undefined)

    const legacyPath = path.join(os.tmpdir(), 'legacy-douyin-fixture.cookies')
    let observed: string | undefined
    const returned = await withDouyinCookieFile(legacyPath, async (file) => {
      observed = file
      return file
    })
    assert.equal(observed, legacyPath)
    assert.equal(returned, legacyPath)
  })
})

test('managed encrypted cookies honor HTTPS, host, and path boundaries', async () => {
  await withDataDir(async () => {
    const store = getDefaultDouyinStore()
    await store.save([
      cookie({ name: 'sessionid', domain: '.douyin.com', path: '/video', value: FIXTURE_VALUE }),
      cookie({ name: 'host_cookie', domain: 'www.douyin.com', path: '/', value: 'host-fixture-value' }),
      cookie({ name: 'login_cookie', domain: 'login.douyin.com', path: '/login', value: 'login-fixture-value' }),
      cookie({ name: 'path_boundary', domain: '.douyin.com', path: '/video', value: 'boundary-fixture-value' })
    ])

    const inScope = await managedDouyinCookieHeader(new URL('https://www.douyin.com/video/item'))
    assert.equal(inScope, [
      `sessionid=${FIXTURE_VALUE}`,
      'host_cookie=host-fixture-value',
      'path_boundary=boundary-fixture-value'
    ].join('; '))
    assert.equal(await managedDouyinCookieHeader(new URL('https://www.douyin.com/videoplay')), 'host_cookie=host-fixture-value')
    assert.equal(await managedDouyinCookieHeader(new URL('https://login.douyin.com/login/fixture')), 'login_cookie=login-fixture-value')
    assert.equal(await managedDouyinCookieHeader(new URL('https://www.douyin.com.evil.test/video/item')), '')
    assert.equal(await managedDouyinCookieHeader(new URL('http://www.douyin.com/video/item')), '')
    assert.equal(await managedDouyinCookieHeader(new URL('https://www.iesdouyin.com/video/item')), '')
  })
})

test('managed cookies treat expires as Unix seconds and honor expiry', async () => {
  const originalDateNow = Date.now
  let clock = FIXTURE_BASE * 1000
  Date.now = () => clock
  try {
    await withDataDir(async () => {
      const expiry = FIXTURE_BASE + 5
      await getDefaultDouyinStore().save([cookie({ expires: expiry })])
      const url = new URL('https://www.douyin.com/')
      assert.equal(await managedDouyinCookieHeader(url), `sessionid=${FIXTURE_VALUE}`)

      clock += 6 * 1000
      assert.equal(await managedDouyinCookieHeader(url), '')
    })
  } finally {
    Date.now = originalDateNow
  }
})

test('withDouyinCookieFile exposes Netscape plaintext only during the callback and cleans up', async () => {
  await withDataDir(async (dataDir) => {
    const expires = Math.floor(Date.now() / 1000) + DAY_SECONDS
    const managed = [
      cookie({ name: 'sessionid', domain: '.douyin.com', path: '/', value: FIXTURE_VALUE, expires }),
      cookie({ name: 'host_cookie', domain: 'www.douyin.com', path: '/download', value: 'host-fixture-value', expires, httpOnly: false, secure: false })
    ]
    await getDefaultDouyinStore().save(managed)

    const tempDirectory = cookieDirectory(dataDir)
    let temporaryPath: string | undefined
    await withDouyinCookieFile(undefined, async (file) => {
      assert.equal(typeof file, 'string')
      temporaryPath = file
      const info = await stat(file as string)
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
      const text = await readFile(file as string, 'utf8')
      assert.equal(text, [
        '# Netscape HTTP Cookie File',
        `#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t${expires - 1}\tsessionid\t${FIXTURE_VALUE}`,
        `www.douyin.com\tFALSE\t/download\tFALSE\t${expires - 1}\thost_cookie\thost-fixture-value`,
        ''
      ].join('\n'))
      assert.deepEqual((await readdir(tempDirectory)).filter((name) => name.endsWith('.cookies')).length, 1)
      return undefined
    })
    assert.equal(temporaryPath !== undefined, true)
    await assert.rejects(() => stat(temporaryPath as string), /ENOENT/)
    assert.deepEqual(await readdir(tempDirectory), [])

    await assert.rejects(() => withDouyinCookieFile(undefined, async (file) => {
      assert.equal(typeof file, 'string')
      assert.equal((await stat(file as string)).isFile(), true)
      throw new Error('fixture consumer failure')
    }), /fixture consumer failure/)
    assert.deepEqual(await readdir(tempDirectory), [])

    const encrypted = await readFile(path.join(dataDir, 'auth', 'douyin', '.session.enc'))
    assert.equal(encrypted.includes(Buffer.from(FIXTURE_VALUE)), false)
    await clearDouyinTemporaryCredentials()
  })
})

test('revoked managed state returns an empty header and suppresses legacy credentials', async () => {
  await withDataDir(async () => {
    const store = getDefaultDouyinStore()
    await store.save([cookie()])
    await store.revoke()

    const url = new URL('https://www.douyin.com/')
    assert.equal(await managedDouyinCookieHeader(url), '')
    let observed: string | undefined = 'not-called'
    const returned = await withDouyinCookieFile('/private/legacy.fixture', async (file) => {
      observed = file
      return file
    })
    assert.equal(observed, undefined)
    assert.equal(returned, undefined)
  })
})
