<template>
  <div class="kv">
    <span class="k">{{ label }}</span>
    <span class="v" :class="valueClass">{{ value }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  valueClass?: string
}>()
</script>
