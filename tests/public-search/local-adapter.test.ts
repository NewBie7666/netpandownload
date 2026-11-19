import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { searchByCode as pureExact } from '../../server/search-core/codeSearch.js'
import { searchGeneralMagnets as pureGeneral } from '../../server/search-core/generalSearch.js'
import { searchByCode as localExact } from '../../server/services/magnets/codeSearch.js'
import { searchGeneralMagnets as localGeneral } from '../../server/services/magnets/generalSearch.js'
import { addDownloadTask } from '../../server/downloader/downloadService.js'

test('local adapters still authorize full-client downloads, including cached pure search results', async () => {
  const originalFetch = globalThis.fetch
  const originalEnabled = process.env.ARIA2_ENABLED
  const originalRpc = process.env.ARIA2_RPC_URL
  const originalSecret = process.env.ARIA2_RPC_SECRET
  process.env.ARIA2_ENABLED = 'true'
  process.env.ARIA2_RPC_URL = 'http://127.0.0.1:16800/jsonrpc'
  process.env.ARIA2_RPC_SECRET = 'fixture-only'
  const dir = await mkdtemp(path.join(tmpdir(), 'netpan-public-adapter-'))
  const hashes = ['a'.repeat(40), 'b'.repeat(40)]
  let adds = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.includes('bitsearch.eu')) return new Response(JSON.stringify({ success: true,
      results: [{ infohash: hashes[1], title: 'Local fixture', seeders: 1 }] }))
    if (url.includes('www.javbus.com/ajax/')) return new Response(`<tr><td><a href="magnet:?xt=urn:btih:${hashes[0]}">Local fixture</a></td></tr>`)
    if (url.includes('www.javbus.com/')) return new Response('var gid=123;var uc=1;')
    const rpc = JSON.parse(String(init?.body))
    if (rpc.method === 'aria2.addUri') adds++
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
      result: rpc.method === 'aria2.addUri' ? 'fixture-' + adds : [] }))
  }) as typeof fetch
  try {
    const searches = [
      { pure: () => pureExact('LOCAL-765'), local: () => localExact('LOCAL-765') },
      { pure: () => pureGeneral('local adapter fixture', 'all', 'bitsearch'), local: () => localGeneral('local adapter fixture', 'all', 'bitsearch') }
    ]
    for (const search of searches) {
      const pure = await search.pure()
      assert.equal(pure.items.length, 1)
      await assert.rejects(addDownloadTask({ url: pure.items[0].magnet, dir }), { error: 'download_url_not_allowed' })
      const local = await search.local()
      assert.equal((await addDownloadTask({ url: local.items[0].magnet, dir })).duplicate, false)
    }
    assert.equal(adds, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (originalEnabled === undefined) delete process.env.ARIA2_ENABLED
    else process.env.ARIA2_ENABLED = originalEnabled
    if (originalRpc === undefined) delete process.env.ARIA2_RPC_URL
    else process.env.ARIA2_RPC_URL = originalRpc
    if (originalSecret === undefined) delete process.env.ARIA2_RPC_SECRET
    else process.env.ARIA2_RPC_SECRET = originalSecret
    await rmdir(dir)
  }
})
