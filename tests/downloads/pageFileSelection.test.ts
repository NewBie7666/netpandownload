import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseVisibleFiles, dropVisibleFiles, filterFileLinks, groupFileExtensions } from '../../src/api/pageFileSelection.js'
import type { PageFileLink } from '../../shared/types.js'

const links:PageFileLink[]=[
  {url:'https://example.org/a.pkg',fileName:'a.pkg',extension:'pkg'},
  {url:'https://example.org/b.pkg',fileName:'b.pkg',extension:'pkg'},
  {url:'https://example.org/m.json',fileName:'m.json',extension:'json'},
  {url:'https://example.org/download',fileName:'download',extension:'other'}
]
test('groups scanned extensions by real counts',()=>{
  assert.deepEqual(groupFileExtensions(links),[
    {extension:'pkg',count:2}, {extension:'json',count:1}, {extension:'other',count:1}
  ])
})
test('hiding a suffix does not delete already selected files',()=>{
  const filtered=filterFileLinks(links,['json'])
  const selected=chooseVisibleFiles([links[0].url],filtered)
  assert.deepEqual(selected,[links[0].url,links[2].url])
  assert.deepEqual(dropVisibleFiles(selected,filtered),[links[0].url])
})
test('select visible obeys per-batch limit and preserves hidden selection',()=>{
  assert.deepEqual(chooseVisibleFiles([],links,2),[links[0].url,links[1].url])
  assert.deepEqual(chooseVisibleFiles([links[2].url],links,2),[links[2].url,links[0].url])
  assert.deepEqual(chooseVisibleFiles([],[],30),[])
})
