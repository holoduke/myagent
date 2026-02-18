<template>
  <div class="stat">
    <div class="num">{{ value }}</div>
    <div class="label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  value: string | number
  label: string
}>()
</script>
