import { expect, test } from '@playwright/test'

const qrPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const verificationMessage = '请在登录窗口完成官方验证，再返回此处；服务器模式下需管理员在运行设备完成验证'

type DouyinStatus = {
  state: 'logged_out' | 'starting' | 'waiting_scan' | 'scanned' | 'authenticated' | 'expired' | 'verification_required' | 'unavailable' | 'error'
  loggedIn: boolean
  available: boolean
  sessionId?: string
  qrImageUrl?: string
  message: string
}

function status(overrides: Partial<DouyinStatus> = {}): DouyinStatus {
  return {
    state: 'logged_out',
    loggedIn: false,
    available: true,
    message: '未登录',
    ...overrides
  }
}

async function fulfillJson(route: import('@playwright/test').Route, result: DouyinStatus) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, result })
  })
}

async function openDouyinModal(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '抖音登录', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '登录抖音', exact: true }).click()
  return page.getByRole('dialog', { name: '登录抖音' })
}

test.describe('Douyin QR login browser UI', () => {
  test('polls mocked QR login from waiting_scan to authenticated and supports logout', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'The QR response and PNG are deterministic browser-route mocks, including a known 1px fixture; this test makes no claim about live Douyin access.'
    })
    const sessionId = 'douyin-browser-session-1'
    let sessionStatusCalls = 0
    let logoutCalls = 0

    await page.route('**/api/auth/douyin/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.endsWith('/image')) {
        await route.fulfill({ status: 200, contentType: 'image/png', body: qrPng })
        return
      }
      if (url.pathname.endsWith('/status') && request.method() === 'GET') {
        if (!url.searchParams.has('sessionId')) {
          await fulfillJson(route, status())
          return
        }
        sessionStatusCalls += 1
        await fulfillJson(route, sessionStatusCalls === 1
          ? status({ state: 'scanned', sessionId, message: '已扫码，等待确认' })
          : status({ state: 'authenticated', loggedIn: true, sessionId, message: '抖音登录成功' }))
        return
      }
      if (url.pathname.endsWith('/qr') && request.method() === 'POST') {
        await fulfillJson(route, status({
          state: 'waiting_scan',
          sessionId,
          qrImageUrl: `/api/auth/douyin/qr/${sessionId}/image`,
          message: '请使用抖音App扫码确认'
        }))
        return
      }
      if (url.pathname.endsWith('/logout') && request.method() === 'POST') {
        logoutCalls += 1
        await fulfillJson(route, status())
        return
      }
      await route.continue()
    })

    const dialog = await openDouyinModal(page)
    await expect(dialog.getByAltText('抖音官方扫码登录二维码')).toBeVisible()
    await expect(dialog.getByText('等待扫码', { exact: true })).toBeVisible()
    await expect.poll(() => sessionStatusCalls, { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
    await expect(dialog.getByText('已扫码，等待确认', { exact: true }).first()).toBeVisible()
    await expect.poll(() => sessionStatusCalls, { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
    await expect(dialog.getByText('已登录', { exact: true })).toBeVisible()
    await expect(dialog.getByAltText('抖音官方扫码登录二维码')).toHaveCount(0)

    await dialog.getByRole('button', { name: '退出抖音登录', exact: true }).click()
    await expect.poll(() => logoutCalls).toBe(1)
    await expect(dialog.getByText('未登录', { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('douyin-auth-status')).toContainText('未登录')
  })

  test('refreshes an expired QR with force=true and stops polling after close', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'Expired and refreshed QR states are deterministic browser-route mocks; the refreshed image is the same known 1px PNG fixture, not a live platform QR.'
    })
    const sessionId = 'douyin-browser-session-refresh'
    const qrBodies: Array<Record<string, unknown>> = []
    let sessionStatusCalls = 0

    await page.route('**/api/auth/douyin/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.endsWith('/image')) {
        await route.fulfill({ status: 200, contentType: 'image/png', body: qrPng })
        return
      }
      if (url.pathname.endsWith('/status') && request.method() === 'GET') {
        if (url.searchParams.has('sessionId')) sessionStatusCalls += 1
        await fulfillJson(route, status())
        return
      }
      if (url.pathname.endsWith('/qr') && request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}') as Record<string, unknown>
        qrBodies.push(body)
        if (qrBodies.length === 1) {
          await fulfillJson(route, status({ state: 'expired', message: '二维码已过期，请刷新二维码' }))
          return
        }
        await fulfillJson(route, status({
          state: 'waiting_scan',
          sessionId,
          qrImageUrl: `/api/auth/douyin/qr/${sessionId}/image`,
          message: '请使用抖音App扫码确认'
        }))
        return
      }
      await route.continue()
    })

    const dialog = await openDouyinModal(page)
    await expect(dialog.getByText('二维码已过期', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '刷新二维码', exact: true }).click()
    await expect(dialog.getByAltText('抖音官方扫码登录二维码')).toBeVisible()
    expect(qrBodies).toEqual([{ force: false }, { force: true }])

    await dialog.getByRole('button', { name: '关闭抖音登录窗口', exact: true }).click()
    await page.waitForTimeout(2_200)
    expect(sessionStatusCalls).toBe(0)
  })

  test('shows the official verification instruction without claiming authentication', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'The verification-required response is a deterministic browser-route mock; no CAPTCHA bypass or live verification is claimed.'
    })
    const sessionId = 'douyin-browser-session-verification'
    await page.route('**/api/auth/douyin/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.endsWith('/status') && request.method() === 'GET') {
        await fulfillJson(route, status({
          state: 'verification_required',
          sessionId,
          message: '需要完成官方验证'
        }))
        return
      }
      if (url.pathname.endsWith('/qr') && request.method() === 'POST') {
        await fulfillJson(route, status({
          state: 'verification_required',
          sessionId,
          message: '需要完成官方验证'
        }))
        return
      }
      await route.continue()
    })

    const dialog = await openDouyinModal(page)
    await expect(dialog.getByText(verificationMessage, { exact: true }).first()).toBeVisible()
    await expect(dialog.getByText('已登录', { exact: true })).toHaveCount(0)
    await expect(page.getByTestId('douyin-auth-status')).toContainText('需要官方验证')
  })

  test('shows unavailable configuration clearly', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'Unavailable and failed status responses are deterministic browser-route mocks; no production configuration or secret path is exposed.'
    })
    let qrCalls = 0
    await page.route('**/api/auth/douyin/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.endsWith('/status') && request.method() === 'GET') {
        await fulfillJson(route, status({ state: 'unavailable', available: false, message: '未配置抖音登录组件' }))
        return
      }
      if (url.pathname.endsWith('/qr') && request.method() === 'POST') {
        qrCalls += 1
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, message: '登录组件尚未配置' })
        })
        return
      }
      await route.continue()
    })

    await page.goto('/')
    await expect(page.getByText('登录组件尚未配置', { exact: true }).first()).toBeVisible()
    const dialog = await openDouyinModal(page)
    await expect(dialog.getByText('登录组件尚未配置', { exact: true }).first()).toBeVisible()
    expect(qrCalls).toBe(0)
  })

  test('surfaces a mocked status API error without claiming authentication', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'The failed status response is a deterministic browser-route mock; the UI reports the error and does not claim a logged-in state.'
    })
    const errorMessage = '抖音登录服务暂不可用，请稍后重试'
    await page.route('**/api/auth/douyin/**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.endsWith('/status') && request.method() === 'GET') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, message: errorMessage })
        })
        return
      }
      await route.continue()
    })

    await page.goto('/')
    await expect(page.getByText(errorMessage, { exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('douyin-auth-status')).toContainText('登录状态异常')
    const dialog = await openDouyinModal(page)
    await expect(dialog.getByText(errorMessage, { exact: true }).first()).toBeVisible()
    await expect(dialog.getByText('已登录', { exact: true })).toHaveCount(0)
  })
})
