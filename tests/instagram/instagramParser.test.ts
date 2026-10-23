import assert from 'node:assert/strict'
import { isInstagramPostUrl, normalizeInstagramPost, parseInstagramGalleryJson } from '../../server/providers/instagram/galleryParser.js'

const normalized = normalizeInstagramPost('https://www.instagram.com/p/Abc_123/?igsh=foo')
assert.equal(normalized.url, 'https://www.instagram.com/p/Abc_123/')
assert.equal(normalized.shareId, 'instagram:p:Abc_123')
assert.equal(isInstagramPostUrl('instagram.com/reel/Abc-1/'), true)

for (const input of [
  'https://instagram.com/example/', 'https://instagram.com/stories/me/1/',
  'https://instagram.com.evil.test/p/123/', 'file:///etc/passwd',
  'http://127.0.0.1/p/foo/', 'https://instagram.com/p/abc/../../admin',
  'https://instagram.com/p/abc:9000/'
]) {
  assert.equal(isInstagramPostUrl(input), false, input)
}

const photo = 'https://scontent.cdninstagram.com/media/one.jpg?sig=xyz'
const video = 'https://instagram.fna.fbcdn.net/media/two.mp4?sig=xyz'
const fixture = JSON.stringify([
  [1, { category: 'instagram' }],
  [2, { post_id: '123' }],
  [3, photo, { extension: 'jpg' }],
  [3, video, { extension: 'mp4', filesize: 1234 }]
])
const result = parseInstagramGalleryJson(fixture, normalized)
assert.equal(result.media.length, 2)
assert.deepEqual(result.media.map(x => x.file.name), [
  'instagram_Abc_123_01.jpg',
  'instagram_Abc_123_02.mp4'
])
assert.equal(result.media[1].file.size, 1234)
assert.equal(result.media[0].file.size, 0)
assert.notEqual(result.media[0].fid, result.media[1].fid)

assert.throws(() => parseInstagramGalleryJson(
  JSON.stringify([[3, 'http://127.0.0.1/admin', { extension: 'jpg' }]]), normalized
))
assert.throws(() => parseInstagramGalleryJson(
  JSON.stringify([[3, photo, { extension: 'jpg' }], [-1, { error: 'AuthError' }]]), normalized
))
assert.throws(() => parseInstagramGalleryJson('[]', normalized))
assert.throws(() => parseInstagramGalleryJson('not json', normalized))
console.log('Instagram single post parser tests passed')
