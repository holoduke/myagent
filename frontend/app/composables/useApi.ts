import type { FetchOptions } from 'ofetch'

const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_DELAY_MS = 1_000
const RETRYABLE_CODES = new Set([408, 429])

function isRetryable(status: number): boolean {
  return RETRYABLE_CODES.has(status) || (status >= 500 && status <= 599)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function useApi() {
  const { token, logout } = useAuth()

  async function api<T>(path: string, options?: FetchOptions): Promise<T> {
    const fetchOptions = {
      ...options,
      timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
      headers: {
        ...options?.headers as Record<string, string>,
        ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
      },
    } as Parameters<typeof $fetch>[1]

    try {
      return await $fetch<T>(path, fetchOptions)
    } catch (e: unknown) {
      const status = e && typeof e === 'object' && 'statusCode' in e
        ? (e as { statusCode: number }).statusCode
        : 0

      if (status === 401) {
        logout()
        throw e
      }

      if (isRetryable(status)) {
        await sleep(RETRY_DELAY_MS)
        try {
          return await $fetch<T>(path, fetchOptions)
        } catch (retryErr: unknown) {
          if (retryErr && typeof retryErr === 'object' && 'statusCode' in retryErr && (retryErr as { statusCode: number }).statusCode === 401) {
            logout()
          }
          throw retryErr
        }
      }

      throw e
    }
  }

  return { api }
}
