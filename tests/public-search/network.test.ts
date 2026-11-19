import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import https from 'node:https'
import dns from 'node:dns'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { publicTransport } from '../../public-search/server/network.js'

test('public transport checks the connected DNS address, caps streams and rejects redirect escape', async () => {
  const scenarios = [
    { name: 'public response', ip: '8.8.8.8', body: 'hello', expected: 'hello' },
    { name: 'private DNS', ip: '127.0.0.1', body: '', error: true },
    { name: 'oversized stream without content length', ip: '8.8.8.8', body: 'x'.repeat(40), error: true },
    { name: 'metadata redirect', ip: '8.8.8.8', body: '', status: 302, location: 'http://169.254.169.254/latest', error: true },
    { name: 'other source redirect', ip: '8.8.8.8', body: '', status: 302, location: 'https://nyaa.si/', error: true },
    { name: 'compressed response rejected', ip: '8.8.8.8', body: 'hello', encoding: 'gzip', error: true }
  ]
  for (const scenario of scenarios) {
    mock.method(dns, 'lookup', (_name: string, _options: unknown, callback: Function) => {
      callback(null, [{ address: scenario.ip, family: 4 }])
    })
    mock.method(https, 'get', (url: URL, options: any, callback: Function) => {
      assert.equal(options.family, 4)
      assert.equal(options.agent, false)
      assert.equal(options.headers['Accept-Encoding'], 'identity')
      const request = new EventEmitter() as EventEmitter & { destroy: (error?: Error) => void }
      request.destroy = error => { if (error) request.emit('error', error) }
      setImmediate(() => options.lookup(url.hostname, {}, (error: Error | null, address: string) => {
        if (error) { request.emit('error', error); return }
        assert.equal(address, '8.8.8.8')
        const response = Readable.from([Buffer.from(scenario.body)]) as Readable & { statusCode: number; headers: Record<string, string> }
        response.statusCode = scenario.status || 200
        response.headers = { ...(scenario.location ? { location: scenario.location } : {}), ...(scenario.encoding ? { 'content-encoding': scenario.encoding } : {}) }
        callback(response)
      }))
      return request
    })
    try {
      const result = publicTransport('https://bitsearch.eu/api/v1/search?q=fixture', { maxBytes: 20, timeoutMs: 1000 })
      if (scenario.error) await assert.rejects(result, undefined, scenario.name)
      else assert.equal((await result).html, scenario.expected)
    } finally { mock.restoreAll() }
  }
})
