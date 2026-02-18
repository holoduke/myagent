<template>
  <div class="node">
    <div class="node-hdr">
      <UiTypeBadge :type="node.type" />
      <span v-if="pinned" class="pinned-icon">pinned</span>
      <span class="str">
        {{ node.strength.toFixed(2) }}
        <span class="str-bar">
          <span class="str-fill" :style="{ width: (node.strength * 100) + '%' }"></span>
        </span>
      </span>
      <span v-if="node.accessCount" class="str" style="margin-left:auto">{{ node.accessCount }} access</span>
      <span v-if="showTime && node.createdAt" class="str" style="margin-left:auto">{{ timeAgo(node.createdAt) }}</span>
    </div>
    <div class="content">{{ truncatedContent }}</div>
    <div v-if="node.tags && node.tags.length" class="tags">
      <span v-for="tag in node.tags" :key="tag" class="tag">{{ tag }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { GraphNode } from '~/types/aria'

const props = defineProps<{
  node: GraphNode
  pinned?: boolean
  showTime?: boolean
}>()

const { timeAgo } = useTimeAgo()

const truncatedContent = computed(() => {
  const c = props.node.content
  return c.length > 300 ? c.slice(0, 300) + '...' : c
})
</script>
