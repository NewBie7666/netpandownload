/** TVBox ecosystem commonly publishes JSON with JavaScript-style comments and trailing commas.
 * Accept only JSON with these two extensions; do NOT evaluate JS/JSON5 expressions.
 */
export function parseCommentedJson(raw: string): unknown {
  let out = ''
  let inside = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const next = raw[i + 1]
    if (inside) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inside = false
      continue
    }
    if (c === '"') { inside = true; out += c; continue }
    if (c === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n' && raw[i] !== '\r') { out += ' '; i++ }
      i--
      continue
    }
    if (c === '/' && next === '*') {
      out += '  '
      i += 2
      let closed = false
      while (i < raw.length) {
        if (raw[i] === '*' && raw[i + 1] === '/') { out += '  '; i++; closed = true; break }
        out += raw[i] === '\r' || raw[i] === '\n' ? raw[i] : ' '
        i++
      }
      if (!closed) throw new SyntaxError('Unterminated JSON block comment')
      continue
    }
    out += c
  }
  let clean = ''
  inside = false
  escaped = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inside) {
      clean += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inside = false
      continue
    }
    if (c === '"') { clean += c; inside = true; continue }
    if (c === ',') {
      let k = i + 1
      while (k < out.length && /\s/.test(out[k])) k++
      if (out[k] === '}' || out[k] === ']') continue
    }
    clean += c
  }
  return JSON.parse(clean.replace(/^\uFEFF/, '')) as unknown
}
