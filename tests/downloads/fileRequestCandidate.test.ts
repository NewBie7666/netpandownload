import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDownloadCandidateUrl } from '../../electron/fileRequestCandidate.js'

test('captures Sony manifest and package requests selected in browser', () => {
  for (const u of [
    'https://sgst.prod.dl.playstation.net/app/info/update.json?sig=1',
    'https://sgst.prod.dl.playstation.net/app/pkg/update_sc.pkg',
    'https://cdn.example.com/update.PKG#fragment',
    'https://cdn.example.com/archive.7z'
  ]) assert.equal(isDownloadCandidateUrl(u), true, u)
})
test('skips non-file URLs, scripts, credentials and unsafe protocols', () => {
  for (const u of [
    'https://example.com/index.html', 'https://example.com/app.js',
    'https://example.com/download', 'https://user:pass@example.com/private.pkg',
    'file:///tmp/file.pkg', '/relative.pkg', '', null
  ]) assert.equal(isDownloadCandidateUrl(u), false, String(u))
})
