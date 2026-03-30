<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      @click="$emit('close')"
      @keydown.escape="$emit('close')"
    >
      <div
        ref="boxRef"
        class="modal-box"
        :style="{ maxWidth: maxWidth || '560px' }"
        tabindex="-1"
        @click.stop
      >
        <div class="modal-header">
          <h2 :id="titleId">
            <span v-if="iconSvg" class="modal-icon" v-html="iconSvg" />
            {{ title }}
          </h2>
          <button class="modal-close" aria-label="Close dialog" @click="$emit('close')">&times;</button>
        </div>
        <div class="modal-body"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
const props = defineProps<{
  open: boolean
  title: string
  icon?: string
  maxWidth?: string
}>()

defineEmits(['close'])

const boxRef = ref<HTMLElement | null>(null)
const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`

// Sanitize icon SVG — only allow <svg> tags with safe attributes
const iconSvg = computed(() => {
  if (!props.icon) return ''
  // Only allow strings that look like SVG markup
  if (!props.icon.trim().startsWith('<svg')) return ''
  // Strip event handlers and script content
  return props.icon
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
})

// Focus the modal box when it opens
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    nextTick(() => boxRef.value?.focus())
  }
})
</script>
