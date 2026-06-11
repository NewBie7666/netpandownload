import type { ApiResponse } from '../shared/types.js'

export function ok<T>(result: T): ApiResponse<T> {
  return { ok: true, result }
}

export function fail(error: string, message: string): ApiResponse<never> {
  return { ok: false, error, message }
}

export class AppError extends Error {
  constructor(
    public readonly error: string,
    message: string,
    public readonly status = 400
  ) {
    super(message)
  }
}
