<template>
  <div class="node" :class="{ expanded, pinned }" @click="expanded = !expanded">
    <div class="node-hdr">
      <UiTypeBadge :type="node.type" />
      <span v-if="pinned" class="pinned-icon">pinned</span>
      <span class="str">
        {{ (node.strength ?? 0).toFixed(2) }}
        <span class="str-bar">
          <span class="str-fill" :style="{ width: ((node.strength ?? 0) * 100) + '%' }"></span>
        </span>
      </span>
      <span v-if="node.accessCount" class="str" style="margin-left:auto">{{ node.accessCount }}x accessed</span>
      <span v-if="showTime && node.createdAt" class="str" style="margin-left:auto">{{ timeAgo(node.createdAt) }}</span>
    </div>
    <div class="content">{{ expanded ? node.content : truncatedContent }}</div>
    <div v-if="node.tags && node.tags.length" class="tags">
      <span v-for="tag in node.tags" :key="tag" class="tag">{{ tag }}</span>
    </div>
    <div v-if="expanded && node.createdAt" class="node-meta">
      <span>Created: {{ fmtDate(node.createdAt) }}</span>
      <span v-if="node.accessCount">Accessed: {{ node.accessCount }} times</span>
      <span>Strength: {{ (node.strength ?? 0).toFixed(4) }}</span>
      <span>ID: {{ node.id.slice(0, 8) }}</span>
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

const { timeAgo, fmtDate } = useTimeAgo()
const expanded = ref(false)

const truncatedContent = computed(() => {
  const c = props.node.content || ''
  return c.length > 200 ? c.slice(0, 200) + '...' : c
})
</script>

<style scoped>
.node { cursor: pointer; transition: border-color .15s; }
.node:hover { border-color: var(--border-glow); }
.node.expanded { border-color: var(--accent); border-left: 3px solid var(--accent); }
.node.pinned { border-left: 3px solid var(--accent-warm); }
.node-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.04);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
}
</style>
