export function useAuth() {
  const token = useCookie('aria_session', {
    maxAge: 86400,
    sameSite: 'strict',
    path: '/',
  })

  const isLoggedIn = computed(() => !!token.value)

  async function login(password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const data = await $fetch<{ success: boolean; token?: string; error?: string }>('/api/login', {
        method: 'POST',
        body: { password },
      })

      if (data.success && data.token) {
        token.value = data.token
        return { success: true }
      }

      return { success: false, error: data.error || 'Access denied' }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Connection error'
      return { success: false, error: msg }
    }
  }

  function logout() {
    token.value = null
    navigateTo('/login')
  }

  async function checkAuth(): Promise<boolean> {
    if (!token.value) return false

    try {
      const data = await $fetch<{ authenticated: boolean }>('/api/auth-check')
      if (!data.authenticated) {
        token.value = null
        return false
      }
      return true
    } catch {
      token.value = null
      return false
    }
  }

  return { token, isLoggedIn, login, logout, checkAuth }
}
