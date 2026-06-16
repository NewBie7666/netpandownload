import { createHash } from 'node:crypto'

const maxTimingJitterMs = 300

function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function getTimingJitterMs(seed: string, adaptiveLevel: number) {
  const level = Math.max(0, Math.min(2, adaptiveLevel))
  if (level <= 0) {
    return 0
  }

  const hash = stableHash(`${seed}:${level}`)
  const range = level === 1 ? 150 : maxTimingJitterMs
  return parseInt(hash.slice(0, 8), 16) % (range + 1)
}

export function getMaxTimingJitterMs() {
  return maxTimingJitterMs
}
