import { assertStructuredLogContract, rcWindowPolicy } from '../release/freezeGuard.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface StructuredLogEntry {
  timestamp: string
  level: LogLevel
  traceId: string
  layer: string
  message: string
  meta?: Record<string, unknown>
}

const recentLogs: StructuredLogEntry[] = []

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item))
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (/cookie|secret|token|authorization/i.test(key)) {
        sanitized[key] = '[redacted]'
      } else {
        sanitized[key] = sanitizeValue(nestedValue)
      }
    }
    return sanitized
  }
  return value
}

function sanitizeMeta(meta?: Record<string, unknown>) {
  if (!meta) return undefined
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (/cookie|secret|token|authorization/i.test(key)) {
      sanitized[key] = '[redacted]'
    } else {
      sanitized[key] = sanitizeValue(value)
    }
  }
  return sanitized
}

function write(level: LogLevel, layer: string, message: string, meta?: Record<string, unknown>, traceId = 'system') {
  const entry: StructuredLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    traceId,
    layer,
    message,
    meta: sanitizeMeta(meta)
  }
  assertStructuredLogContract(entry)
  recentLogs.push(entry)
  trimStructuredLogWindow()
  const line = JSON.stringify(entry)
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export function trimStructuredLogWindow() {
  while (recentLogs.length > rcWindowPolicy.maxLogEvents) {
    recentLogs.shift()
  }
}

export function resetStructuredLogWindow() {
  recentLogs.splice(0, recentLogs.length)
}

export function listRecentStructuredLogs() {
  trimStructuredLogWindow()
  return recentLogs.map((entry) => ({ ...entry, meta: entry.meta ? { ...entry.meta } : undefined }))
}

export const structuredLogger = {
  debug(layer: string, message: string, meta?: Record<string, unknown>, traceId?: string) {
    if (process.env.LOG_LEVEL === 'debug') write('debug', layer, message, meta, traceId)
  },
  info(layer: string, message: string, meta?: Record<string, unknown>, traceId?: string) {
    write('info', layer, message, meta, traceId)
  },
  warn(layer: string, message: string, meta?: Record<string, unknown>, traceId?: string) {
    write('warn', layer, message, meta, traceId)
  },
  error(layer: string, message: string, meta?: Record<string, unknown>, traceId?: string) {
    write('error', layer, message, meta, traceId)
  }
}
