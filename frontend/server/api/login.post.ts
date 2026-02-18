import { getApiUrl } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const base = getApiUrl()

  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await res.json()

  if (data.success && data.token) {
    // Set HttpOnly cookie for server-side proxy auth
    setCookie(event, 'aria_token', data.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 86400, // 24 hours
    })
  }

  setResponseStatus(event, res.status)
  return data
})
