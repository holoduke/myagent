import { getApiUrl, getAuthToken } from '../utils/proxy'

export default defineEventHandler(async (event) => {
  const token = getAuthToken(event)
  if (!token) {
    return { authenticated: false }
  }

  const base = getApiUrl()
  const res = await fetch(`${base}/api/auth-check`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })

  const data = await res.json()
  return data
})
