// One-off compatibility smoke. Reads JSON metadata only; does not execute Spider/JAR or fetch video media.
const source = 'https://api.hgyx.vip/hgyx.json'
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 12000)
try {
  const response = await fetch(source, {
    signal: controller.signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NetPanDownload-ConfigProbe/1.0)', Accept: 'application/json' }
  })
  console.log('HG probe HTTP:', response.status, 'content-type:', response.headers.get('content-type'))
  console.log('HG probe final host:', new URL(response.url).hostname)
  if (!response.ok) throw Error('non-2xx response')
  const reader = response.body?.getReader()
  if (!reader) throw Error('empty response')
  let bytes = 0
  const chunks = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > 1_500_000) throw Error('config exceeds 1.5MB bound')
    chunks.push(value)
  }
  const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  console.log('HG probe raw prefix (URLs redacted):', JSON.stringify(raw.slice(0, 500).replace(/https?:\\/\\/[^\\s"']+/g, '[URL]')))
  const json = JSON.parse(raw)
  console.log('HG probe bytes:', bytes, 'top-level type:', typeof json)
  if (!Array.isArray(json?.sites)) {
    console.log('HG probe: NO sites array; top-level keys:', Object.keys(json || {}).slice(0, 15))
    process.exitCode = 2
  } else {
    const counts = Object.create(null)
    for (const site of json.sites) {
      const kind = String(site?.type ?? 'missing')
      counts[kind] = (counts[kind] || 0) + 1
    }
    console.log('HG probe total sites:', json.sites.length, 'type counts:', JSON.stringify(counts))
    console.log('HG probe compatible type=1:', (counts['1'] || 0), 'unsupported:', json.sites.length - (counts['1'] || 0))
    console.log('HG probe has spider field:', typeof json.spider === 'string' && !!json.spider)
  }
} catch (error) {
  console.log('HG probe cannot verify live source:', error instanceof Error ? error.message : String(error))
  process.exitCode = 2
} finally {
  clearTimeout(timeout)
}
