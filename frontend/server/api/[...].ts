import { getApiUrl, proxyHeaders } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const method = getMethod(event)

  // Only handle GET, POST, PUT, PATCH (DELETE has its own handler)
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return

  const path = getRequestURL(event).pathname
  const search = getRequestURL(event).search || ''
  const base = getApiUrl()
  const url = `${base}${path}${search}`

  const fetchOptions: RequestInit = {
    method,
    headers: proxyHeaders(event),
  }

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const body = await readBody(event)
    if (body) {
      fetchOptions.body = JSON.stringify(body)
    }
  }

  try {
    const res = await fetch(url, fetchOptions)

    setResponseStatus(event, res.status)

    const contentType = res.headers.get('content-type') || 'application/json'
    setResponseHeader(event, 'content-type', contentType)

    if (contentType.includes('text/event-stream')) {
      setResponseHeaders(event, {
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      if (res.body) {
        return sendStream(event, res.body as unknown as ReadableStream)
      }
      return ''
    }

    return res.json()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[proxy] Error fetching ${url}:`, message)
    setResponseStatus(event, 502)
    return { error: true, message: 'Service temporarily unavailable' }
  }
})
