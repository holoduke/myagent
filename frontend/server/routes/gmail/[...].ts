import { getApiUrl, proxyHeaders } from '../../utils/proxy'

/**
 * Catch-all proxy for /gmail/* routes (OAuth flow).
 * These routes live outside /api/ on the backend:
 *   GET /gmail/accounts
 *   GET /gmail/auth/:accountId  → returns 302 redirect to Google OAuth
 *   GET /gmail/callback         → handles OAuth callback from Google
 *
 * We use redirect: 'manual' so 302s are passed through to the browser
 * rather than being followed server-side.
 */
export default defineEventHandler(async (event) => {
  const { pathname, search } = getRequestURL(event)
  const base = getApiUrl()
  const url = `${base}${pathname}${search}`

  const res = await fetch(url, {
    method: getMethod(event),
    headers: proxyHeaders(event),
    redirect: 'manual',
  })

  // Pass through redirects (e.g. 302 to Google OAuth consent screen)
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    if (location) {
      return sendRedirect(event, location, res.status)
    }
  }

  setResponseStatus(event, res.status)

  const contentType = res.headers.get('content-type') || 'text/html'
  setResponseHeader(event, 'content-type', contentType)

  // Gmail callback returns HTML pages
  if (contentType.includes('text/html')) {
    return res.text()
  }

  return res.json()
})
