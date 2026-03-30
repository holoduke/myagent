<template>
  <Teleport to="body">
    <div class="toast-container" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.type" :role="toast.type === 'error' ? 'alert' : undefined">
          {{ toast.message }}
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
const { toasts } = useToast()
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  padding: 12px 20px;
  border-radius: 10px;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text);
  background: var(--bg-card);
  border: 1px solid var(--border);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  max-width: 360px;
}

.toast.success {
  border-color: var(--green);
  box-shadow: 0 0 12px rgba(34, 197, 94, 0.25);
}

.toast.error {
  border-color: var(--red);
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.25);
}

.toast.info {
  border-color: var(--accent);
  box-shadow: 0 0 12px rgba(168, 85, 247, 0.2);
}

.toast-enter-active {
  transition: all 0.3s ease;
}
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
