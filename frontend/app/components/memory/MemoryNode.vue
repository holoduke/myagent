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
    <!-- Relationships panel -->
    <div v-if="expanded && relationships.length" class="rel-panel" @click.stop>
      <div class="rel-header">Relationships ({{ relationships.length }})</div>
      <div v-for="rel in relationships" :key="rel.nodeId + rel.edgeType" class="rel-row">
        <span class="rel-direction" :class="rel.direction">{{ rel.direction === 'outgoing' ? '\u2192' : '\u2190' }}</span>
        <span class="rel-edge-badge">{{ rel.edgeType }}</span>
        <UiTypeBadge :type="rel.nodeType" />
        <span class="rel-content">{{ truncateRel(rel.nodeContent) }}</span>
        <span class="rel-weight">{{ rel.edgeWeight.toFixed(2) }}</span>
      </div>
    </div>
    <div v-if="expanded && relLoading" class="rel-loading" @click.stop>Loading relationships...</div>
    <div v-if="expanded && relError" class="rel-error" @click.stop>{{ relError }}</div>
  </div>
</template>

<script setup lang="ts">
import type { GraphNode, MemoryRelationship } from '~/types/aria'

const props = defineProps<{
  node: GraphNode
  pinned?: boolean
  showTime?: boolean
  parentConcepts?: string[]
  childCount?: number
}>()

const { api } = useApi()
const { timeAgo, fmtDate } = useTimeAgo()
const expanded = ref(false)
const relationships = ref<MemoryRelationship[]>([])
const relLoading = ref(false)
const relError = ref('')
const relLoaded = ref(false)

watch(expanded, async (isExpanded) => {
  if (isExpanded && !relLoaded.value) {
    relLoading.value = true
    relError.value = ''
    try {
      const data = await api<MemoryRelationship[]>(`/api/memory/node/${props.node.id}/relationships`)
      relationships.value = data
      relLoaded.value = true
    } catch (e) {
      relError.value = e instanceof Error ? e.message : 'Failed to load relationships'
    } finally {
      relLoading.value = false
    }
  }
})

const truncatedContent = computed(() => {
  const c = props.node.content || ''
  return c.length > 200 ? c.slice(0, 200) + '...' : c
})

function truncateRel(content: string): string {
  return content.length > 120 ? content.slice(0, 120) + '...' : content
}
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

/* Relationships panel */
.rel-panel {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
.rel-header {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.rel-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.02);
}
.rel-row:last-child { border-bottom: none; }
.rel-direction {
  font-size: 14px;
  font-weight: 700;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
.rel-direction.outgoing { color: var(--accent); }
.rel-direction.incoming { color: var(--accent-warm, #e0a060); }
.rel-edge-badge {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.06);
  color: var(--text-dim);
  white-space: nowrap;
  flex-shrink: 0;
}
.rel-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}
.rel-weight {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-ghost);
  flex-shrink: 0;
}
.rel-loading, .rel-error {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.06);
  font-family: var(--mono);
  font-size: 11px;
}
.rel-loading { color: var(--text-ghost); }
.rel-error { color: var(--red); }
</style>
