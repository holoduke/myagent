<template>
  <button class="btn" :class="variant" @click="$emit('click')">
    <slot />
  </button>
</template>

<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'danger'
}>()

defineEmits(['click'])
</script>
