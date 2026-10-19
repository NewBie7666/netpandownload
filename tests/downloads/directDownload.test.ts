import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateDirectDownloadInput } from '../../server/downloader/directDownload.js'

const publicDns = async () => ['93.184.215.14']

test('accepts HTTP/HTTPS with optional filename and removes hash', async () => {
  assert.deepEqual(
    await validateDirectDownloadInput({ url: 'https://example.com/download.zip?token=abc#section', fileName: 'archive.zip' }, publicDns),
    { url: 'https://example.com/download.zip?token=abc', fileName: 'archive.zip' }
  )
  assert.equal((await validateDirectDownloadInput({ url: 'http://example.com/' }, publicDns)).fileName, undefined)
})

test('rejects credentials, non-HTTP protocols and invalid URL data', async () => {
  for (const url of [
    'file:///etc/passwd', 'ftp://example.com/file', 'javascript:alert(1)',
    'https://user:pass@example.com/file', '', 'not a URL', 'https://'
  ]) {
    await assert.rejects(() => validateDirectDownloadInput({ url }, publicDns))
  }
  await assert.rejects(() => validateDirectDownloadInput(null, publicDns))
})

test('blocks localhost, reserved and private address variants', async () => {
  const urls = [
    'http://localhost/file', 'http://other.local/a', 'http://intranet/a',
    'http://127.0.0.1/file', 'http://2130706433/file', 'http://0x7f000001/',
    'http://10.0.0.1/file', 'http://172.16.20.1/file',
    'http://192.168.1.1/', 'http://169.254.1.1/', 'http://100.64.1.1/',
    'http://[::1]/', 'http://[fc00::1]/', 'http://[::ffff:127.0.0.1]/'
  ]
  for (const url of urls) {
    await assert.rejects(() => validateDirectDownloadInput({ url }, publicDns), url)
  }
})

test('checks DNS, including mixed public/private addresses', async () => {
  await assert.rejects(() => validateDirectDownloadInput(
    { url: 'https://example.com/a' }, async () => ['93.184.215.14', '192.168.0.1']
  ))
  await assert.rejects(() => validateDirectDownloadInput(
    { url: 'https://example.com/a' }, async () => []
  ))
  await assert.rejects(() => validateDirectDownloadInput(
    { url: 'https://example.com/a' }, async () => { throw new Error('ENOTFOUND') }
  ))
})

test('rejects unsafe output names; ignores arbitrary download directory', async () => {
  for (const name of [
    '../secret.txt', '..\\secret', 'foo/bar', 'CON', 'nul.txt',
    'bad:name.zip', 'C:\\temp\\pwn', 'bad?.zip', '.'
  ]) {
    await assert.rejects(() => validateDirectDownloadInput({ url: 'https://example.com/a', fileName: name }, publicDns))
  }
  assert.deepEqual(
    await validateDirectDownloadInput({ url: 'https://example.com/file', dir: 'C:\\unsafe' }, publicDns),
    { url: 'https://example.com/file', fileName: undefined }
  )
})
