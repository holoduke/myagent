import { getApiUrl, proxyHeaders } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  const base = getApiUrl()
  const url = `${base}${path}`

  const body = await readBody(event)

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: proxyHeaders(event),
      body: body ? JSON.stringify(body) : undefined,
    })

    setResponseStatus(event, res.status)
    return res.json()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[proxy] DELETE error ${url}:`, message)
    setResponseStatus(event, 502)
    return { error: true, message: 'Service temporarily unavailable' }
  }
})
