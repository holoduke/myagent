<template>
  <div class="login-wrapper">
    <div class="login-eye">
      <div class="eye-core"></div>
    </div>
    <div class="login-card">
      <h1>ARIA</h1>
      <p class="subtitle">Mainframe Access</p>
      <input
        ref="passwordInput"
        v-model="password"
        type="password"
        placeholder="Enter access code"
        autofocus
        @keydown.enter="doLogin"
      >
      <button @click="doLogin" :disabled="loading">
        {{ loading ? 'Connecting...' : 'Initialize' }}
      </button>
      <div class="login-err">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'auth' })

// Clear any stale HttpOnly cookie from server during SSR
if (import.meta.server) {
  const event = useRequestEvent()
  if (event) {
    const { setCookie } = await import('h3')
    setCookie(event, 'aria_token', '', { httpOnly: true, maxAge: 0, path: '/' })
  }
}

const { login } = useAuth()
const password = ref('')
const error = ref('')
const loading = ref(false)
const passwordInput = ref<HTMLInputElement>()

async function doLogin() {
  if (loading.value || !password.value) return
  error.value = ''
  loading.value = true

  const result = await login(password.value)
  loading.value = false

  if (result.success) {
    navigateTo('/overview')
  } else {
    error.value = result.error || 'Access denied'
  }
}

onMounted(() => {
  passwordInput.value?.focus()
})
</script>

<style scoped>
.login-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 24px 16px;
  box-sizing: border-box;
}
.login-eye {
  width: 80px;
  height: 80px;
  min-height: 80px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  box-shadow: 0 0 15px rgba(255,77,42,0.4), 0 0 40px rgba(255,77,42,0.15), inset 0 0 20px rgba(255,77,42,0.15);
  margin-bottom: 24px;
  position: relative;
  animation: eye-breathe 3s ease-in-out infinite;
  flex-shrink: 0;
}
.login-eye::after {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,77,42,0.08) 0%, transparent 70%);
  animation: eye-glow 3s ease-in-out infinite;
}
.eye-core {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,77,42,0.35) 0%, rgba(255,77,42,0.05) 60%, transparent 80%);
  animation: core-pulse 3s ease-in-out infinite;
}
@keyframes eye-breathe {
  0%, 100% { box-shadow: 0 0 15px rgba(255,77,42,0.4), 0 0 40px rgba(255,77,42,0.15), inset 0 0 20px rgba(255,77,42,0.15); transform: scale(1); }
  50% { box-shadow: 0 0 25px rgba(255,77,42,0.6), 0 0 60px rgba(255,77,42,0.25), inset 0 0 30px rgba(255,77,42,0.25); transform: scale(1.03); }
}
@keyframes eye-glow {
  0%, 100% { opacity: 0.5; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.15); }
}
@keyframes core-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
.login-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 40px 36px;
  width: min(380px, 90vw);
  text-align: center;
  box-shadow: 0 20px 60px rgba(0,0,0,.5), var(--glow-card);
}
.login-card h1 {
  font-family: var(--mono);
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
  text-shadow: var(--glow-accent);
  letter-spacing: 6px;
  text-transform: uppercase;
}
.login-card .subtitle {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
  margin: 8px 0 28px;
  letter-spacing: 2px;
  text-transform: uppercase;
}
.login-card input {
  width: 100%;
  padding: 13px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  font-family: var(--mono);
  outline: none;
  transition: all .2s;
}
.login-card input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(255,77,42,0.1);
}
.login-card button {
  width: 100%;
  padding: 13px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  margin-top: 16px;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--mono);
  letter-spacing: 2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all .2s;
}
.login-card button:hover {
  background: rgba(255,77,42,0.1);
  box-shadow: var(--glow-accent);
}
.login-card button:disabled { opacity: 0.5; cursor: not-allowed; }
.login-err { color: var(--red); font-size: 13px; min-height: 18px; margin-top: 12px; font-family: var(--mono); }
</style>
