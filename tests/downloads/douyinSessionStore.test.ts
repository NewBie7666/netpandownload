import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DouyinSessionStore } from '../../server/auth/douyin/sessionStore.js'
import type { DouyinCookie } from '../../server/auth/douyin/types.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const NOW_SECONDS = Math.floor(NOW / 1000)
const DAY_SECONDS = DAY / 1000

function cookie(overrides: Partial<DouyinCookie> = {}): DouyinCookie {
  return {
    name: 'sessionid',
    value: 'session-secret-value-0123456789',
    domain: '.douyin.com',
    path: '/',
    expires: NOW_SECONDS + 2 * DAY_SECONDS,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides
  }
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'netpan-douyin-session-'))
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

test('stores encrypted authenticated sessions with bounded expiry and survives a new instance', async () => {
  const root = await temporaryRoot()
  try {
    const store = new DouyinSessionStore(root, () => NOW)
    assert.deepEqual(await store.read(), {
      override: false,
      status: 'absent',
      cookies: [],
      expiresAt: null
    })

    const auth = cookie()
    const auxiliary = cookie({
      name: 'passport_csrf_token',
      value: 'csrf-token',
      expires: 0
    })
    const shortLived = cookie({
      name: 'device_id',
      value: 'device-token',
      expires: NOW_SECONDS + DAY_SECONDS
    })
    const hostOnlyAuth = cookie({
      name: 'sessionid_ss',
      value: 'host-session-secret-0123456789',
      domain: 'www.douyin.com'
    })
    const loginCookie = cookie({
      name: 'login_ticket',
      value: 'login-token',
      domain: 'login.douyin.com'
    })
    const iesCookie = cookie({
      name: 'ies_token',
      value: 'ies-token',
      domain: '.sub.iesdouyin.com'
    })
    await store.save([auth, auxiliary, shortLived, hostOnlyAuth, loginCookie, iesCookie])

    const encoded = await readFile(path.join(root, '.session.enc'))
    const key = await readFile(path.join(root, '.key'))
    assert.equal(key.length, 32)
    assert.equal(encoded.includes(Buffer.from(auth.value)), false)
    assert.equal(encoded.includes(Buffer.from(key.toString('hex'))), false)
    assert.equal(encoded.includes(Buffer.from(key.toString('base64'))), false)

    if (process.platform !== 'win32') {
      assert.equal((await stat(root)).mode & 0o777, 0o700)
      assert.equal((await stat(path.join(root, '.key'))).mode & 0o777, 0o600)
      assert.equal((await stat(path.join(root, '.session.enc'))).mode & 0o777, 0o600)
    }

    const state = await new DouyinSessionStore(root, () => NOW).read()
    assert.equal(state.override, true)
    assert.equal(state.status, 'authenticated')
    assert.equal(state.expiresAt, auth.expires * 1000)
    assert.equal(state.cookies.find((item) => item.name === 'sessionid')?.expires, auth.expires - 1)
    assert.equal(state.cookies.find((item) => item.name === 'passport_csrf_token')?.expires, auth.expires - 1)
    assert.equal(state.cookies.find((item) => item.name === 'device_id')?.expires, shortLived.expires - 1)
  } finally {
    await cleanup(root)
  }
})

test('caps session lifetime at seven days and reports expiry fail-closed', async () => {
  const root = await temporaryRoot()
  let now = NOW
  try {
    const store = new DouyinSessionStore(root, () => now)
    const auth = cookie({ expires: NOW_SECONDS + 30 * DAY_SECONDS })
    await store.save([auth])
    const authenticated = await store.read()
    assert.equal(authenticated.status, 'authenticated')
    assert.equal(authenticated.expiresAt, NOW + 7 * DAY)
    assert.equal(authenticated.cookies[0]?.expires, NOW_SECONDS + 7 * DAY_SECONDS - 1)

    now = NOW + 7 * DAY
    assert.deepEqual(await store.read(), {
      override: true,
      status: 'expired',
      cookies: [],
      expiresAt: NOW + 7 * DAY
    })
  } finally {
    await cleanup(root)
  }
})

test('revoke writes a tombstone that remains logged out across instances', async () => {
  const root = await temporaryRoot()
  try {
    const store = new DouyinSessionStore(root, () => NOW)
    await store.save([cookie()])
    await store.revoke()
    assert.deepEqual(await new DouyinSessionStore(root, () => NOW).read(), {
      override: true,
      status: 'logged_out',
      cookies: [],
      expiresAt: null
    })
    assert.equal((await stat(path.join(root, '.session.enc'))).isFile(), true)
  } finally {
    await cleanup(root)
  }
})

test('rejects corrupted ciphertext and never falls back to manual cookies', async () => {
  const root = await temporaryRoot()
  try {
    const store = new DouyinSessionStore(root, () => NOW)
    await store.save([cookie()])
    const encoded = await readFile(path.join(root, '.session.enc'))
    encoded[encoded.length - 1] = encoded[encoded.length - 1] ^ 1
    await writeFile(path.join(root, '.session.enc'), encoded)
    assert.deepEqual(await store.read(), {
      override: true,
      status: 'invalid',
      cookies: [],
      expiresAt: null
    })
  } finally {
    await cleanup(root)
  }
})

test('rejects unsupported domains and anonymous or expired cookies', async () => {
  const root = await temporaryRoot()
  try {
    const store = new DouyinSessionStore(root, () => NOW)
    for (const domain of [
      'evil.example',
      'douyin.com.evil.example',
      'www..douyin.com',
      'www.douyin.com:443',
      'www.douyin.com\u0000'
    ]) {
      await assert.rejects(() => store.save([cookie({ domain })]), /domain/)
    }
    await assert.rejects(() => store.save([cookie({ name: 'other_cookie' })]), /auth cookie/)
    await assert.rejects(() => store.save([cookie({ value: 'short' })]), /auth cookie/)
    await assert.rejects(() => store.save([cookie({ expires: NOW_SECONDS - 1 })]), /auth cookie/)
    await assert.rejects(() => store.save([cookie({ value: 'value\r\nwith-injection' })]), /cookie value/)
  } finally {
    await cleanup(root)
  }
})

test('serializes concurrent writes and leaves no plaintext or temporary files', async () => {
  const root = await temporaryRoot()
  try {
    const stores = [new DouyinSessionStore(root, () => NOW), new DouyinSessionStore(root, () => NOW)]
    await Promise.all(Array.from({ length: 32 }, (_, index) => stores[index % stores.length].save([
      cookie({ value: `session-secret-${String(index).padStart(2, '0')}-0123456789` })
    ])))
    const state = await stores[0].read()
    assert.equal(state.status, 'authenticated')
    assert.equal(state.cookies.length, 1)
    assert.match(state.cookies[0]?.value ?? '', /^session-secret-\d{2}-0123456789$/)
    assert.deepEqual((await readdir(root)).sort(), ['.key', '.session.enc'])
  } finally {
    await cleanup(root)
  }
})

test('rejects directory, key, and session symlinks on platforms that support symlinks', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink permissions vary on Windows')
    return
  }

  const parent = await temporaryRoot()
  const realRoot = path.join(parent, 'real')
  const linkedRoot = path.join(parent, 'linked')
  try {
    await mkdir(realRoot)
    try {
      await symlink(realRoot, linkedRoot, 'dir')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) {
        t.skip('symlink creation is not permitted')
        return
      }
      throw error
    }
    assert.equal((await new DouyinSessionStore(linkedRoot, () => NOW).read()).status, 'invalid')
    await assert.rejects(() => new DouyinSessionStore(linkedRoot, () => NOW).save([cookie()]))

    const root = path.join(parent, 'files')
    await mkdir(root)
    const externalKey = path.join(parent, 'external.key')
    await writeFile(externalKey, Buffer.alloc(32, 7))
    await symlink(externalKey, path.join(root, '.key'))
    await assert.rejects(() => new DouyinSessionStore(root, () => NOW).save([cookie()]))

    const sessionRoot = path.join(parent, 'session')
    await mkdir(sessionRoot)
    const sessionStore = new DouyinSessionStore(sessionRoot, () => NOW)
    await sessionStore.save([cookie()])
    const externalSession = path.join(parent, 'external.session')
    await writeFile(externalSession, await readFile(path.join(sessionRoot, '.session.enc')))
    await unlink(path.join(sessionRoot, '.session.enc'))
    await symlink(externalSession, path.join(sessionRoot, '.session.enc'))
    assert.equal((await sessionStore.read()).status, 'invalid')
    await assert.rejects(() => sessionStore.revoke())
  } finally {
    await cleanup(parent)
  }
})
