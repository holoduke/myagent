export function useVisibilityRefresh(refreshFn: () => Promise<void>) {
  const { checkAuth, logout } = useAuth()

  let hiddenAt = 0

  function onVisibilityChange() {
    if (document.hidden) {
      hiddenAt = Date.now()
      return
    }

    // Tab became visible — only act if hidden for >5s
    if (!hiddenAt || Date.now() - hiddenAt < 5_000) return

    checkAuth().then((valid) => {
      if (!valid) {
        logout()
        return
      }
      refreshFn()
    })
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
}
