import { getApiUrl } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const base = getApiUrl()
  const url = `${base}/api/login`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()

    setResponseStatus(event, res.status)
    return data
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[login] Proxy error to ${url}:`, message)
    setResponseStatus(event, 502)
    return { error: true, message: 'Service temporarily unavailable' }
  }
})
