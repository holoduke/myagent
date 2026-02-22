<template>
  <div class="node" :class="{ expanded, pinned, concept: node.type === 'concept' }" @click="expanded = !expanded">
    <div v-if="parentConcepts && parentConcepts.length" class="parent-badges">
      <span v-for="pc in parentConcepts" :key="pc" class="parent-badge">{{ pc }}</span>
    </div>
    <div class="node-hdr">
      <UiTypeBadge :type="node.type" />
      <span v-if="pinned" class="pinned-icon">pinned</span>
      <span v-if="childCount" class="child-count">{{ childCount }} children</span>
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
  parentConcepts?: string[]
  childCount?: number
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
.node.concept { border-left: 3px solid #c080e0; }
.parent-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.parent-badge {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #2a1a2e;
  color: #c080e0;
  border: 1px solid #3a2a40;
}
.child-count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 4px;
}
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
