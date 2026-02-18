<template>
  <span class="status-dot" :class="status"></span>
</template>

<script setup lang="ts">
defineProps<{
  status: 'ok' | 'warn' | 'err'
}>()
</script>
