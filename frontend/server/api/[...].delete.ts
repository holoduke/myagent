import { getApiUrl, proxyHeaders } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  const base = getApiUrl()
  const url = `${base}${path}`

  const body = await readBody(event)

  const res = await fetch(url, {
    method: 'DELETE',
    headers: proxyHeaders(event),
    body: body ? JSON.stringify(body) : undefined,
  })

  setResponseStatus(event, res.status)
  return res.json()
})
