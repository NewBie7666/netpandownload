import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createPinnedHlsLookup, createHlsResourceReader, readHlsResource } from '../../server/hls/hlsNetwork.js'

test('Type3 player headers reach HLS transport and credentials stop at cross-host redirects', async () => {
  const calls: Array<{ host: string; headers: unknown }> = []
  const reader = createHlsResourceReader({
    resolvePublicAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    routesFor: async () => [{ kind: 'direct' }],
    requestOne: async (url, _pin, _route, _max, _signal, _referer, _range, headers) => {
      calls.push({ host: url.hostname, headers })
      return calls.length === 1
        ? { bytes: Buffer.alloc(0), location: 'https://cdn.example.org/segment.ts', statusCode: 302, headers: {} }
        : { bytes: Buffer.from('DATA'), location: '', statusCode: 200, headers: { 'content-length': '4' } }
    }
  })
  await reader('https://media.example.org/segment.ts', 32, undefined, undefined, undefined,
    { 'User-Agent': 'Spider', Referer: 'https://media.example.org/', Cookie: 'session=secret', Authorization: 'Bearer secret' })
  assert.deepEqual(calls, [
    { host: 'media.example.org', headers: { 'User-Agent': 'Spider', Referer: 'https://media.example.org/', Cookie: 'session=secret', Authorization: 'Bearer secret' } },
    { host: 'cdn.example.org', headers: { 'User-Agent': 'Spider', Referer: 'https://media.example.org/' } }
  ])
})

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

test('range transport sends a bounded Range header and validates 206 Content-Range', async () => {
  const calls: Array<{ range?: { offset: number, length: number } }> = []
  const reader = createHlsResourceReader({
    resolvePublicAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    routesFor: async () => [{ kind: 'direct' }],
    requestOne: async (_url, _pin, _route, _maxBytes, _signal, _referer, range) => {
      calls.push({ range })
      return {
        bytes: Buffer.from('DATA'),
        location: '',
        statusCode: 206,
        headers: {
          'content-range': 'bytes 5-8/100',
          'content-length': '4',
          'content-encoding': 'identity'
        }
      }
    }
  })
  const result = await reader('https://media.example.com/video.ts', 32, undefined, undefined, { offset: 5, length: 4 })
  assert.equal(result.data.toString(), 'DATA')
  assert.deepEqual(calls, [{ range: { offset: 5, length: 4 } }])
})

test('range responses that ignore Range or report a malformed interval fail closed', async () => {
  const makeReader = (statusCode: number, headers: Record<string, string>, bytes = Buffer.from('DATA')) =>
    createHlsResourceReader({
      resolvePublicAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
      routesFor: async () => [{ kind: 'direct' }],
      requestOne: async () => ({ bytes, location: '', statusCode, headers })
    })
  await assert.rejects(
    () => makeReader(200, { 'content-length': '4' })('https://media.example.com/video.ts', 32, undefined, undefined, { offset: 5, length: 4 }),
    (error: unknown) => (error as { error?: string }).error === 'hls_range_unsupported'
  )
  await assert.rejects(
    () => makeReader(206, { 'content-range': 'bytes 6-9/100', 'content-length': '4' })('https://media.example.com/video.ts', 32, undefined, undefined, { offset: 5, length: 4 }),
    (error: unknown) => (error as { error?: string }).error === 'hls_invalid_content_range'
  )
  await assert.rejects(
    () => makeReader(206, { 'content-range': 'bytes 5-8/100', 'content-length': '3' }, Buffer.from('DAT'))('https://media.example.com/video.ts', 32, undefined, undefined, { offset: 5, length: 4 }),
    (error: unknown) => (error as { error?: string }).error === 'hls_range_length_mismatch'
  )
})

test('byte-range inputs are bounded before DNS or transport work', async () => {
  let called = false
  const reader = createHlsResourceReader({
    resolvePublicAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
    routesFor: async () => [{ kind: 'direct' }],
    requestOne: async () => {
      called = true
      return { bytes: Buffer.from('x'), location: '', statusCode: 200, headers: { 'content-length': '1' } }
    }
  })
  for (const range of [
    { offset: -1, length: 1 },
    { offset: 0, length: 0 },
    { offset: 0, length: 33 },
    { offset: Number.MAX_SAFE_INTEGER, length: 2 }
  ]) {
    await assert.rejects(
      () => reader('https://media.example.com/video.ts', 32, undefined, undefined, range),
      (error: unknown) => (error as { error?: string }).error === 'hls_invalid_range'
    )
  }
  assert.equal(called, false)
})

test('redirect DNS rebinding to a private address is rejected before the second request', async () => {
  let resolveCount = 0
  let requestCount = 0
  const reader = createHlsResourceReader({
    resolvePublicAddresses: async () => {
      resolveCount++
      return resolveCount === 1
        ? [{ address: '1.1.1.1', family: 4 }]
        : [{ address: '10.0.0.1', family: 4 }]
    },
    routesFor: async () => [{ kind: 'direct' }],
    requestOne: async () => {
      requestCount++
      return {
        bytes: Buffer.alloc(0),
        location: 'https://media.example.com/video.ts',
        statusCode: 302,
        headers: { location: 'https://media.example.com/video.ts' }
      }
    }
  })
  await assert.rejects(
    () => reader('https://media.example.com/video.ts', 32),
    (error: unknown) => (error as { error?: string }).error === 'hls_private_address'
  )
  assert.equal(requestCount, 1)
})

test('HTTP 403/404 remains factual about access restrictions and does not claim expiry', async () => {
  for (const statusCode of [403, 404]) {
    const reader = createHlsResourceReader({
      resolvePublicAddresses: async () => [{ address: '1.1.1.1', family: 4 }],
      routesFor: async () => [{ kind: 'direct' }],
      requestOne: async () => ({ bytes: Buffer.alloc(0), location: '', statusCode, headers: {} })
    })
    await assert.rejects(
      () => reader('https://media.example.com/video.ts', 32),
      (error: unknown) => {
        const value = error as { error?: string, message?: string }
        return value.error === 'hls_http_error' && value.message?.includes('地区/IP') === true && !value.message.includes('过期')
      }
    )
  }
})
