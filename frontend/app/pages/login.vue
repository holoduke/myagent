<template>
  <div>
    <div class="login-ring"></div>
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
.login-ring {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  box-shadow: var(--glow-accent), inset 0 0 20px rgba(255,77,42,0.15);
  margin-bottom: 24px;
  animation: pulse-ring 3s ease-in-out infinite;
  position: relative;
}
.login-ring::after {
  content: '';
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,77,42,0.3) 0%, transparent 70%);
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
