import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookupPublicAddresses } from '../../server/downloader/pageLinkScanner.js'

test('DNS resolver returns the list required for HTTP all-address lookups', async () => {
  const data = [
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 }
  ]
  assert.deepEqual(await lookupPublicAddresses('example.com', async () => data), data)
})

test('DNS resolver rejects undefined and private results without invalid IP exceptions', async () => {
  await assert.rejects(() => lookupPublicAddresses('bad.test', async () => [{ address: undefined as unknown as string, family: 4 }]), /网页域名/)
  await assert.rejects(() => lookupPublicAddresses('internal.test', async () => [{ address: '192.168.1.9', family: 4 }]), /网页域名/)
  await assert.rejects(() => lookupPublicAddresses('internal.test', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]), /网页域名/)
  await assert.rejects(() => lookupPublicAddresses('bad.test', async () => []), /网页域名/)
})
