import { expect, test } from '@playwright/test'

const copiedDouyin = '复制打开抖音，看看这个作品 https://v.douyin.com/AbC12_/ 复制此消息'
const normalizedDouyin = 'https://v.douyin.com/AbC12_/'
const copiedXhs = '复制打开小红书，看看这篇笔记 https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=token%2Bwith%2Fquery&xsec_source=pc_share 复制'
const normalizedXhs = 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=token%2Bwith%2Fquery&xsec_source=pc_share'

type SocialFile = {
  fid: string
  name: string
  size: number
  isDir: false
  createdAt: string
}

function mediaFile(fid: string, name: string, size: number): SocialFile {
  return { fid, name, size, isDir: false, createdAt: new Date(0).toISOString() }
}

async function openPrivateWeb(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '文件列表' })).toBeVisible()
  await expect(page.getByText('内置下载器：可用')).toBeVisible()
}

async function installResolveMock(
  page: import('@playwright/test').Page,
  providerId: 'douyin' | 'xiaohongshu',
  expectedInput: string,
  files: SocialFile[]
) {
  const requests: Array<Record<string, unknown>> = []
  await page.route('**/api/providers/resolve', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>
    requests.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        result: {
          providerId,
          share: {
            shareId: `${providerId}:browser-fixture`,
            stoken: `${providerId}-browser-token`,
            path: [],
            files
          }
        }
      })
    })
  })

  return requests
}

test.describe('social share-link browser acceptance', () => {
  test('recognizes copied Douyin text, shows support notice, and filters images/videos', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'The compiled private-web UI and browser fixture are real; only /api/providers/resolve is a deterministic provider-response mock, so no claim is made about live Douyin access.'
    })
    const files = [
      mediaFile('douyin-image', 'douyin-cover.jpg', 1024),
      mediaFile('douyin-video', 'douyin-video.mp4', 2048)
    ]
    const requests = await installResolveMock(page, 'douyin', normalizedDouyin, files)

    await openPrivateWeb(page)
    await page.locator('#share-url').fill(copiedDouyin)
    await page.getByRole('button', { name: '解析资源' }).click()

    await expect(page.getByText('已通过 抖音 获取 2 个文件')).toBeVisible()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]?.input).toBe(normalizedDouyin)
    expect(requests[0]?.passcode).toBe('')

    const fileRows = page.locator('.file-panel tbody tr')
    await expect(fileRows.filter({ hasText: 'douyin-cover.jpg' })).toHaveCount(1)
    await expect(fileRows.filter({ hasText: 'douyin-video.mp4' })).toHaveCount(1)
    const mediaFilter = page.getByRole('combobox', { name: '筛选媒体类型' })
    await expect(mediaFilter).toBeVisible()

    await mediaFilter.selectOption('image')
    await expect(fileRows.filter({ hasText: 'douyin-cover.jpg' })).toHaveCount(1)
    await expect(fileRows.filter({ hasText: 'douyin-video.mp4' })).toHaveCount(0)

    await mediaFilter.selectOption('video')
    await expect(fileRows.filter({ hasText: 'douyin-cover.jpg' })).toHaveCount(0)
    await expect(fileRows.filter({ hasText: 'douyin-video.mp4' })).toHaveCount(1)
  })

  test('recognizes copied Xiaohongshu text and preserves xsec query parameters', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'The provider API response is a deterministic browser-route mock; the assertion proves copied XHS text is normalized without dropping the signed xsec query.'
    })
    const files = [
      mediaFile('xhs-image', 'xiaohongshu-cover.webp', 1024),
      mediaFile('xhs-video', 'xiaohongshu-video.mp4', 4096)
    ]
    const requests = await installResolveMock(page, 'xiaohongshu', normalizedXhs, files)

    await openPrivateWeb(page)
    await page.locator('#share-url').fill(copiedXhs)
    await page.getByRole('button', { name: '解析资源' }).click()

    await expect(page.getByText('已通过 小红书 获取 2 个文件')).toBeVisible()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]?.input).toBe(normalizedXhs)
    expect(String(requests[0]?.input)).toContain('xsec_token=token%2Bwith%2Fquery')
    expect(String(requests[0]?.input)).toContain('xsec_source=pc_share')

    const fileRows = page.locator('.file-panel tbody tr')
    const mediaFilter = page.getByRole('combobox', { name: '筛选媒体类型' })
    await expect(mediaFilter).toBeVisible()
    await mediaFilter.selectOption('image')
    await expect(fileRows.filter({ hasText: 'xiaohongshu-cover.webp' })).toHaveCount(1)
    await expect(fileRows.filter({ hasText: 'xiaohongshu-video.mp4' })).toHaveCount(0)
  })
})
