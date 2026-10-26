import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const expectedMovieSha = 'c56c0e5be99e3c459041d67fc06c2af4ff5bd9641e926133be83687f6be6fbe0'

async function openPrivateWeb(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '文件列表' })).toBeVisible()
  await expect(page.getByText('内置下载器：可用')).toBeVisible()
}

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }))
  expect(dimensions.body, `body overflow: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport)
  expect(dimensions.document, `document overflow: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport)
}

test.describe('private web browser acceptance', () => {
  test('completed files are saved to the current device and incomplete files are withheld', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'Actual compiled Vue page, Express file-stream route and browser download. aria2 RPC is a local deterministic mock.'
    })
    await openPrivateWeb(page)
    await assertNoHorizontalOverflow(page)

    const completedRow = page.locator('tr').filter({ hasText: 'movie.mp4' }).first()
    const incompleteRow = page.locator('tr').filter({ hasText: 'unfinished.mp4' }).first()
    await expect(completedRow).toBeVisible()
    await expect(incompleteRow).toBeVisible()
    const saveLink = completedRow.locator('a.file-save-link[download="movie.mp4"]')
    await expect(saveLink).toHaveCount(1)
    await expect(incompleteRow.locator('a.file-save-link')).toHaveCount(0)

    const downloadPromise = page.waitForEvent('download')
    await saveLink.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('movie.mp4')
    const downloadedPath = await download.path()
    expect(downloadedPath).toBeTruthy()
    const bytes = await readFile(downloadedPath!)
    expect(bytes.toString('utf8')).toBe('movie-test-12')
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedMovieSha)
  })

  test('static scan suffix selection, per-file selection and 30-item batches work', async ({ page }) => {
    test.info().annotations.push({
      type: 'evidence',
      description: 'Static scanner result and /api/downloads/direct responses are deterministic browser-route mocks; selection and batch UI are real.'
    })
    const scanItems = Array.from({ length: 30 }, (_, index) => ({
      url: `https://cdn.test/packages/update-${index + 1}.zip`,
      fileName: `update-${index + 1}.zip`,
      extension: 'zip'
    }))
    scanItems.push({
      url: 'https://cdn.test/packages/manifest.json',
      fileName: 'manifest.json',
      extension: 'json'
    })
    const directCalls: unknown[] = []

    await openPrivateWeb(page)
    await page.route('**/api/downloads/scan-page', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          result: {
            pageUrl: 'https://downloads.test/index.html',
            extensions: ['zip', 'json'],
            items: scanItems,
            truncated: false
          }
        })
      })
    })
    await page.route('**/api/downloads/direct', async (route) => {
      directCalls.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result: { gid: '0000000000000001' } })
      })
    })

    await page.locator('#page-scan-url').fill('https://downloads.test/index.html')
    await page.getByRole('button', { name: '扫描 HTML（静态）' }).click()
    await expect(page.locator('.page-scan-item')).toHaveCount(31)
    await assertNoHorizontalOverflow(page)

    const zipOption = page.locator('.page-type-option').filter({ hasText: '.zip (30)' }).locator('input[type="checkbox"]')
    await expect(zipOption).toHaveCount(1)
    await zipOption.check()
    await expect(page.locator('.page-scan-toolbar > span')).toContainText('已选 30 个')

    const manifest = page.locator('.page-scan-item').filter({ hasText: 'manifest.json' }).locator('input[type="checkbox"]')
    await manifest.check()
    await expect(page.locator('.page-scan-toolbar > span')).toContainText('本次提交 30 个，剩余 1 个需再次点击下载')
    await expect(page.getByRole('button', { name: '下载本批 (30/31)' })).toBeVisible()

    await page.getByRole('button', { name: '下载本批 (30/31)' }).click()
    await expect.poll(() => directCalls.length).toBe(30)
    await expect(page.locator('.page-scan-message')).toContainText('本次提交 30 个：已加入 aria2 30 个')
    await expect(page.getByRole('button', { name: '下载本批 (1/1)' })).toBeVisible()

    await page.getByRole('button', { name: '下载本批 (1/1)' }).click()
    await expect.poll(() => directCalls.length).toBe(31)
    await expect(page.locator('.page-scan-message')).toContainText('本次提交 1 个：已加入 aria2 1 个')
  })
})
