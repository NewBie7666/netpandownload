// Explicitly metadata-only test for the user-supplied HLS playlist URL.
// No video segments, keys, or full episode media are downloaded.
import { readHlsResource } from '../server/hls/hlsNetwork.js'
import { parseHlsMediaPlaylist, selectHlsVariant } from '../server/hls/hlsParser.js'

const url = 'https://v.cdnlz29.com/20251203/10034_e709a74f/index.m3u8'
try {
  const { data, url: finalUrl } = await readHlsResource(url, 1_000_000)
  const body = data.toString('utf8')
  const variant = selectHlsVariant(body, finalUrl)
  if (variant) {
    console.log('HLS metadata OK: master playlist; variant host:', new URL(variant).hostname)
  } else {
    const playlist = parseHlsMediaPlaylist(body, finalUrl)
    console.log('HLS metadata OK:', JSON.stringify({
      segmentCount: playlist.segments.length,
      durationSeconds: Math.round(playlist.duration),
      hasAes128: playlist.segments.some(segment => !!segment.keyUrl)
    }))
  }
} catch (e) {
  const error = e as { error?: string, code?: string, message?: string }
  console.log('HLS metadata probe failed:', error.error || error.code || 'network_error', error.message || '')
  process.exitCode = 2
}
