import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invokeJavaScriptSource, Type3JavaScriptError } from '../../server/video-sources/type3-js.js'

const source = (code: string) => ({
  id: 'fixture-js',
  apiUrl: 'csp_Fixture',
  ext: code
})

test('Type3 JavaScript module executes init/home/search/detail/play in a child process', async () => {
  const code = `
    export default {
      init(ext) { globalThis.__type3.calls = ['init:' + typeof ext]; },
      home() { return { class: [{ type_id: 'movie', type_name: '电影' }] }; },
      search(keyword, page) { return { list: [{ vod_id: keyword + '-' + page, vod_name: '结果' }] }; },
      detail(id) { return { list: [{ vod_id: id, vod_name: '详情' }] }; },
      play(flag, id) { return { parse: 0, url: 'https://media.example.com/' + flag + '/' + id + '.mp4' }; }
    };
  `
  const home = await invokeJavaScriptSource(source(code), 'home', {})
  const search = await invokeJavaScriptSource(source(code), 'search', { keyword: '星际', page: 2 })
  const detail = await invokeJavaScriptSource(source(code), 'detail', { id: '42' })
  const play = await invokeJavaScriptSource(source(code), 'play', { flag: 'line', id: '42' })
  assert.deepEqual(home, { class: [{ type_id: 'movie', type_name: '电影' }] })
  assert.deepEqual(search, { list: [{ vod_id: '星际-2', vod_name: '结果' }] })
  assert.deepEqual(detail, { list: [{ vod_id: '42', vod_name: '详情' }] })
  assert.deepEqual(play, { parse: 0, url: 'https://media.example.com/line/42.mp4' })
})

test('Type3 JavaScript legacy globals and CatVod aliases are supported', async () => {
  const code = `
    function init() { return { searchContent: function(wd, quick, pg) { return { list: [{ vod_id: wd + pg, vod_name: quick ? '快' : '慢' }] }; }, playerContent: function(flag, id) { return { url: flag + ':' + id }; } }; }
    function homeContent() { return { class: [{ type_id: 'x', type_name: '测试' }] }; }
    globalThis.detail = function(id) { return { list: [{ vod_id: id }] }; };
  `
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'home'), { class: [{ type_id: 'x', type_name: '测试' }] })
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'search', { keyword: 'abc', page: 3 }), { list: [{ vod_id: 'abc3', vod_name: '慢' }] })
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'detail', { id: 'd1' }), { list: [{ vod_id: 'd1' }] })
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'play', { flag: 'f', id: 'p' }), { url: 'f:p' })
})

test('Type3 JavaScript CatVod aliases receive TVBox argument shapes', async () => {
  const code = `
    export default {
      homeContent(filter) { return { filter }; },
      detailContent(ids) { return { id: ids[0], isArray: Array.isArray(ids) }; },
      playerContent(flag, id, flags) { return { flag, id, flags }; }
    };
  `
  const input = { id: 'a', flag: '线路', page: 1 }
  assert.deepEqual(await invokeJavaScriptSource({ ...source(code), flags: ['线路', '备用'] }, 'home'), { filter: true })
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'detail', input), { id: 'a', isArray: true })
  assert.deepEqual(await invokeJavaScriptSource({ ...source(code), flags: ['线路', '备用'] }, 'play', input), { flag: '线路', id: 'a', flags: ['线路', '备用'] })
})

test('Type3 JavaScript recognizes minified export-list modules', async () => {
  const code = `const home=()=>({class:[{type_id:'x'}]});export{home};`
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'home'), { class: [{ type_id: 'x' }] })
})

test('Type3 selector helpers preserve pdfa outer HTML and support && descendants', async () => {
  const code = `
    export default {
      search() {
        const html = '<div class="item"><a href="/one">One</a></div><div class="item"><a href="/two">Two</a></div>';
        return {
          nodes: pdfa(html, 'div.item'),
          links: pdfa(html, 'div&&a&&href'),
          nestedNodes: pdfa(html, 'body&&div.item'),
          firstHref: pdfh(html, 'div.item&&a&&href'),
          firstText: pdfh(html, 'div.item&&a&&Text')
        };
      }
    };
  `
  assert.deepEqual(await invokeJavaScriptSource(source(code), 'search'), {
    nodes: ['<div class="item"><a href="/one">One</a></div>', '<div class="item"><a href="/two">Two</a></div>'],
    links: ['/one', '/two'],
    nestedNodes: ['<div class="item"><a href="/one">One</a></div>', '<div class="item"><a href="/two">Two</a></div>'],
    firstHref: '/one',
    firstText: 'One'
  })
})

test('Type3 JavaScript reports unsupported shapes and empty output explicitly', async () => {
  await assert.rejects(
    () => invokeJavaScriptSource(source('export default { init() {} };'), 'search', { keyword: 'x' }),
    (error: unknown) => error instanceof Type3JavaScriptError && error.code === 'type3_js_unsupported_shape'
  )
  await assert.rejects(
    () => invokeJavaScriptSource(source('export default { search() { return []; } };'), 'search', { keyword: 'x' }),
    (error: unknown) => error instanceof Type3JavaScriptError && error.code === 'type3_js_empty_result'
  )
  await assert.rejects(
    () => invokeJavaScriptSource(source('export default { search() { return "{}"; } };'), 'search', { keyword: 'x' }),
    (error: unknown) => error instanceof Type3JavaScriptError && error.code === 'type3_js_empty_result'
  )
})

test('Type3 JavaScript synchronous evaluation is bounded', async () => {
  const started = Date.now()
  await assert.rejects(
    () => invokeJavaScriptSource(source('export default { search() { while (true) {} } };'), 'search', { keyword: 'x' }),
    (error: unknown) => error instanceof Type3JavaScriptError && ['type3_js_runtime_error', 'type3_js_worker_exit', 'type3_js_timeout'].includes(error.code)
  )
  assert.ok(Date.now() - started < 20_000)
})
