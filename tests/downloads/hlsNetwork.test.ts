import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createPinnedHlsLookup, readHlsResource } from '../../server/hls/hlsNetwork.js'

test('Node 22 pinned DNS callback returns address array for all:true, scalar otherwise', () => {
  const lookup = createPinnedHlsLookup({ address: '203.0.113.1', family: 4 })
  lookup('cdn.example', { all: true }, (error: unknown, addresses: unknown) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [{ address: '203.0.113.1', family: 4 }])
  })
  lookup('cdn.example', { all: false }, (error: unknown, address: unknown, family: unknown) => {
    assert.equal(error, null)
    assert.equal(address, '203.0.113.1')
    assert.equal(family, 4)
  })
})

test('real Node HTTP socket with pinned DNS resolves rather than ERR_INVALID_IP_ADDRESS', async () => {
  const server = createServer((_req, res) => { res.end('#EXTM3U\n#EXT-X-ENDLIST') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const req = request('http://test-hls.invalid:' + address.port + '/', {
        lookup: createPinnedHlsLookup({ address: '127.0.0.1', family: 4 }),
        ...({ autoSelectFamily: false } as Record<string, unknown>)
      }, res => {
        const body: Buffer[] = []
        res.on('data', (chunk: Buffer) => body.push(chunk))
        res.on('end', () => resolve(Buffer.concat(body).toString('utf8')))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
    assert.match(text, /^#EXTM3U/)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('live HLS fetcher still blocks loopback, private IP and disallowed ports', async () => {
  for (const url of [
    'http://127.0.0.1/index.m3u8',
    'http://10.0.0.1/index.m3u8',
    'http://example.org:8080/index.m3u8',
    'file:///etc/passwd'
  ]) await assert.rejects(() => readHlsResource(url, 1024), url)
})
