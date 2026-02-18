export default defineNuxtRouteMiddleware((to) => {
  const { isLoggedIn } = useAuth()

  if (to.path === '/login') {
    if (isLoggedIn.value) {
      return navigateTo('/overview')
    }
    return
  }

  if (!isLoggedIn.value) {
    return navigateTo('/login')
  }
})
