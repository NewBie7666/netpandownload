import http from 'node:http'

// Native HTTP preserves an explicit proxy Host header across Node versions.
export function proxyRequest(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method || 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()), signal: init.signal || undefined
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve(new Response(init.method === 'HEAD' ? null : Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers as Record<string, string>
      })))
    })
    request.on('error', reject)
    request.end(typeof init.body === 'string' ? init.body : undefined)
  })
}
