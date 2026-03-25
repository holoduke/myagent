<template>
  <div class="req-card" :class="request.status">
    <div class="req-header">
      <span class="req-badge" :class="request.status">{{ statusLabel }}</span>
      <span class="req-action-type">{{ request.actionType.replace('_', ' ') }}</span>
      <span class="req-time">{{ timeAgo(request.timestamp) }}</span>
    </div>
    <div class="req-contact">
      {{ request.contactName }}
      <span v-if="request.isGroup && request.groupName" class="req-group">in {{ request.groupName }}</span>
    </div>
    <div class="req-message">{{ request.message }}</div>
    <div class="req-summary">{{ request.actionSummary }}</div>
    <div v-if="request.appliedPolicy !== 'no-directive'" class="req-policy">
      Policy: {{ request.appliedPolicy }}
    </div>
    <div v-if="request.status === 'pending'" class="req-actions">
      <button class="btn primary sm" :disabled="acting" @click="$emit('approve', request.id)">Approve</button>
      <button class="btn danger sm" :disabled="acting" @click="$emit('reject', request.id)">Reject</button>
    </div>
    <div v-if="request.resolutionNote" class="req-note">{{ request.resolutionNote }}</div>
  </div>
</template>

<script setup lang="ts">
import type { ContactRequest } from '~/types/aria'

const props = defineProps<{
  request: ContactRequest
  acting?: boolean
}>()

defineEmits<{
  approve: [id: string]
  reject: [id: string]
}>()

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  auto_executed: 'Auto-executed',
}

const statusLabel = computed(() => {
  return statusLabels[props.request.status] || props.request.status
})

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}
</script>

<style scoped>
.req-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  transition: border-color .15s;
}
.req-card.pending { border-left: 3px solid #eab308; }
.req-card.approved { border-left: 3px solid #22c55e; }
.req-card.rejected { border-left: 3px solid #6b7280; }
.req-card.auto_executed { border-left: 3px solid #3b82f6; }

.req-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.req-badge {
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
}
.req-badge.pending { background: rgba(234,179,8,0.15); color: #eab308; }
.req-badge.approved { background: rgba(34,197,94,0.15); color: #22c55e; }
.req-badge.rejected { background: rgba(107,114,128,0.15); color: #6b7280; }
.req-badge.auto_executed { background: rgba(59,130,246,0.15); color: #3b82f6; }

.req-action-type {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.req-time {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  margin-left: auto;
}
.req-contact {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.req-group {
  font-weight: 400;
  color: var(--text-muted);
  font-size: 12px;
}
.req-message {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
  margin-bottom: 4px;
  padding: 6px 8px;
  background: var(--bg-surface);
  border-radius: 6px;
}
.req-summary {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.req-policy {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-ghost);
  margin-bottom: 6px;
}
.req-actions {
  display: flex;
  gap: 8px;
  padding-top: 6px;
}
.req-note {
  font-size: 11px;
  color: var(--text-ghost);
  font-style: italic;
  margin-top: 4px;
}
.btn.sm {
  font-size: 12px;
  padding: 4px 12px;
}
</style>
