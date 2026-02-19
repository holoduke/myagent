import type { FetchOptions } from 'ofetch'

export function useApi() {
  const { token, logout } = useAuth()

  async function api<T>(path: string, options?: FetchOptions): Promise<T> {
    try {
      return await $fetch<T>(path, {
        ...options,
        headers: {
          ...options?.headers as Record<string, string>,
          ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
        },
      } as Parameters<typeof $fetch>[1])
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'statusCode' in e && (e as { statusCode: number }).statusCode === 401) {
        logout()
      }
      throw e
    }
  }

  return { api }
}
