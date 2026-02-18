import { getApiUrl, getAuthToken } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const token = getAuthToken(event)
  if (!token) {
    setResponseStatus(event, 401)
    return { error: 'Unauthorized' }
  }

  const body = await readBody(event)
  const base = getApiUrl()

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (res.status === 401) {
    setResponseStatus(event, 401)
    return { error: 'Unauthorized' }
  }

  // Stream SSE response through
  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const stream = res.body
  if (!stream) {
    return ''
  }

  return sendStream(event, stream as unknown as ReadableStream)
})
