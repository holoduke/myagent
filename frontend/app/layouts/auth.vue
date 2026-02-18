<template>
  <div class="auth-layout">
    <slot />
  </div>
</template>

<style scoped>
.auth-layout {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100dvh;
  flex-direction: column;
  background: radial-gradient(ellipse at 50% 30%, #0f0a18 0%, var(--bg) 70%);
  overflow: auto;
}
</style>
