<template>
  <button class="btn" :class="[variant, { loading }]" :disabled="disabled || loading" @click="$emit('click')">
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'danger'
  loading?: boolean
  disabled?: boolean
}>()

defineEmits(['click'])
</script>

<style scoped>
.btn.loading {
  position: relative;
  pointer-events: none;
}
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  margin-right: 6px;
  vertical-align: middle;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
