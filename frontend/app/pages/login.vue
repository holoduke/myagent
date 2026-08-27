<template>
  <div class="login-wrapper">
    <div class="login-eye">
      <div class="eye-core"></div>
    </div>
    <div class="login-card">
      <h1>ARIA</h1>
      <p class="subtitle">Personal agent dashboard</p>
      <input
        ref="passwordInput"
        v-model="password"
        type="password"
        placeholder="Enter access code"
        autofocus
        @keydown.enter="doLogin"
      >
      <button @click="doLogin" :disabled="loading">
        {{ loading ? 'Signing in…' : 'Sign in' }}
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
    navigateTo('/')
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
  width: 100%;
  padding: 24px 16px;
  box-sizing: border-box;
}
.login-eye {
  width: 56px;
  height: 56px;
  min-height: 56px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  margin-bottom: 24px;
  position: relative;
  flex-shrink: 0;
}
.eye-core {
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(139,92,246,0.5) 0%, rgba(139,92,246,0.08) 65%, transparent 85%);
  animation: core-pulse 3s ease-in-out infinite;
}
@keyframes core-pulse {
  0%, 100% { opacity: 0.6; }
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
  font-family: var(--sans);
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 4px;
}
.login-card .subtitle {
  color: var(--text-muted);
  font-size: 13px;
  margin: 6px 0 28px;
}
.login-card input {
  width: 100%;
  padding: 12px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: all .2s;
}
.login-card input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(139,92,246,0.1);
}
.login-card button {
  width: 100%;
  padding: 12px;
  border-radius: var(--radius);
  border: 1px solid var(--accent);
  margin-top: 16px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all .2s;
}
.login-card button:hover {
  background: #9d71f8;
  border-color: #9d71f8;
}
.login-card button:disabled { opacity: 0.5; cursor: not-allowed; }
.login-err { color: var(--red); font-size: 13px; min-height: 18px; margin-top: 12px; }
</style>
