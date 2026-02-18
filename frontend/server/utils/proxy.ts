import type { H3Event } from 'h3'

export function getApiUrl(): string {
  const config = useRuntimeConfig()
  return config.apiUrl
}

export function getAuthToken(event: H3Event): string | null {
  const cookie = getCookie(event, 'aria_token')
  if (cookie) return cookie

  const auth = getHeader(event, 'authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  return null
}

export function proxyHeaders(event: H3Event): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const token = getAuthToken(event)
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

export async function forwardToBackend(
  event: H3Event,
  path: string,
  options?: {
    method?: string
    body?: unknown
  },
): Promise<Response> {
  const base = getApiUrl()
  const url = `${base}${path}`
  const method = options?.method || getMethod(event)

  const fetchOptions: RequestInit = {
    method,
    headers: proxyHeaders(event),
  }

  if (options?.body) {
    fetchOptions.body = JSON.stringify(options.body)
  } else if (method !== 'GET' && method !== 'HEAD') {
    const body = await readBody(event)
    if (body) {
      fetchOptions.body = JSON.stringify(body)
    }
  }

  return fetch(url, fetchOptions)
}
