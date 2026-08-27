<template>
  <div class="section">
    <LayoutSectionHeader>Memory Snapshots</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-if="!error">
      <!-- Stats -->
      <UiCard title="Backup Overview" :icon="icons.overview" style="margin-bottom:16px">
        <div class="stat-grid">
          <UiStatCard :value="backups.length" label="Total Backups" />
          <UiStatCard :value="latestDateLabel" label="Latest Backup" />
          <UiStatCard :value="latestNodeCount" label="Nodes in Latest" />
          <UiStatCard :value="nextBackupLabel" label="Next Auto-Backup" />
        </div>
      </UiCard>

      <!-- Manual Backup -->
      <div class="action-bar">
        <button class="btn btn-primary" :disabled="creating" @click="doCreate">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 5v14m-7-7h14"/></svg>
          {{ creating ? 'Creating...' : 'Create Backup Now' }}
        </button>
      </div>

      <!-- Backup List -->
      <UiCard title="Backups" :icon="icons.list" style="margin-bottom:16px">
        <div v-if="backups.length" class="backup-list">
          <div v-for="b in backups" :key="b.timestamp" class="backup-row">
            <div class="backup-info">
              <div class="backup-date">
                {{ fmtDate(b.timestamp) }}
                <span class="backup-ago">{{ timeAgo(b.timestamp) }}</span>
              </div>
              <div class="backup-stats">
                <span class="stat-chip">{{ b.nodeCount }} nodes</span>
                <span class="stat-chip">{{ b.edgeCount }} edges</span>
                <span v-if="b.archiveCount" class="stat-chip">{{ b.archiveCount }} archived</span>
                <span class="stat-chip">{{ formatSize(b.totalSizeBytes) }}</span>
                <span class="badge" :class="b.createdBy">{{ b.createdBy }}</span>
              </div>
            </div>
            <div class="backup-actions">
              <button class="btn btn-sm" @click="viewDetail(b.timestamp)">Details</button>
              <button class="btn btn-sm btn-warn" @click="confirmRestore(b)">Restore</button>
              <button class="btn btn-sm btn-danger" @click="confirmDelete(b)">Delete</button>
            </div>
          </div>
        </div>
        <div v-else class="empty-hint" style="padding:40px">
          No backups yet -- daily automatic backups will begin soon
        </div>
      </UiCard>
    </template>

    <!-- Detail Modal -->
    <UiModal :open="!!detailData" title="Backup Details" :icon="icons.detail" @close="detailData = null">
      <template v-if="detailData">
        <div class="detail-grid">
          <div class="kv"><span class="k">Date</span><span class="v">{{ detailData.date }}</span></div>
          <div class="kv"><span class="k">Created By</span><span class="v">{{ detailData.createdBy }}</span></div>
          <div class="kv"><span class="k">Nodes</span><span class="v">{{ detailData.nodeCount }}</span></div>
          <div class="kv"><span class="k">Edges</span><span class="v">{{ detailData.edgeCount }}</span></div>
          <div class="kv"><span class="k">Archived</span><span class="v">{{ detailData.archiveCount }}</span></div>
          <div class="kv"><span class="k">Ghosts</span><span class="v">{{ detailData.ghostCount }}</span></div>
          <div class="kv"><span class="k">Size</span><span class="v">{{ formatSize(detailData.totalSizeBytes) }}</span></div>
        </div>
        <div v-if="detailData.nodeTypeBreakdown && Object.keys(detailData.nodeTypeBreakdown).length" style="margin-top:12px">
          <span class="detail-label">Node Types</span>
          <div class="type-chips">
            <span v-for="(count, type) in detailData.nodeTypeBreakdown" :key="type" class="type-badge">{{ type }}: {{ count }}</span>
          </div>
        </div>
        <div v-if="detailData.pinnedNodes?.length" style="margin-top:12px">
          <span class="detail-label">Pinned Nodes</span>
          <div class="pinned-list">
            <div v-for="n in detailData.pinnedNodes" :key="n.id" class="pinned-item">
              <span class="pinned-type">{{ n.type }}</span>
              <span class="pinned-content">{{ n.content }}</span>
            </div>
          </div>
        </div>
      </template>
    </UiModal>

    <!-- Restore Confirm Modal -->
    <UiModal :open="!!restoreTarget" title="Confirm Restore" :icon="icons.warn" @close="restoreTarget = null">
      <p class="confirm-text">
        This will overwrite the current memory graph with the backup from
        <strong>{{ restoreTarget ? fmtDate(restoreTarget.timestamp) : '' }}</strong>.
      </p>
      <p class="confirm-text" style="color:var(--yellow)">
        This action cannot be undone. Consider creating a backup first.
      </p>
      <div class="modal-actions">
        <button class="btn" @click="restoreTarget = null">Cancel</button>
        <button class="btn btn-warn" :disabled="restoring" @click="doRestore">
          {{ restoring ? 'Restoring...' : 'Restore Backup' }}
        </button>
      </div>
    </UiModal>

    <!-- Delete Confirm Modal -->
    <UiModal :open="!!deleteTarget" title="Confirm Delete" :icon="icons.warn" @close="deleteTarget = null">
      <p class="confirm-text">
        Delete the backup from <strong>{{ deleteTarget ? fmtDate(deleteTarget.timestamp) : '' }}</strong>?
      </p>
      <div class="modal-actions">
        <button class="btn" @click="deleteTarget = null">Cancel</button>
        <button class="btn btn-danger" :disabled="deleting" @click="doDelete">
          {{ deleting ? 'Deleting...' : 'Delete' }}
        </button>
      </div>
    </UiModal>
  </div>
</template>

<script setup lang="ts">
import type { BackupMeta, BackupDetail } from '~/types/aria'

const { api } = useApi()
const { showToast } = useToast()
const { timeAgo, fmtDate } = useTimeAgo()

const backups = ref<BackupMeta[]>([])
const error = ref('')
const creating = ref(false)
const restoring = ref(false)
const deleting = ref(false)
const detailData = ref<BackupDetail | null>(null)
const restoreTarget = ref<BackupMeta | null>(null)
const deleteTarget = ref<BackupMeta | null>(null)

const latestDateLabel = computed(() => {
  if (!backups.value.length) return 'None'
  return timeAgo(backups.value[0].timestamp)
})

const latestNodeCount = computed(() => {
  if (!backups.value.length) return 0
  return backups.value[0].nodeCount
})

const nextBackupLabel = computed(() => {
  if (!backups.value.length) return 'Soon'
  const elapsed = Date.now() - backups.value[0].timestamp
  const remaining = Math.max(0, 24 * 60 * 60 * 1000 - elapsed)
  if (remaining === 0) return 'Due now'
  const hours = Math.floor(remaining / (60 * 60 * 1000))
  const mins = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000))
  if (hours > 0) return `~${hours}h ${mins}m`
  return `~${mins}m`
})

function formatSize(bytes: number): string {
  if (!bytes) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

async function loadBackups() {
  try {
    backups.value = await api<BackupMeta[]>('/api/brain/backups')
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
    showToast(error.value, 'error')
  }
}

async function doCreate() {
  creating.value = true
  try {
    await api<BackupMeta>('/api/brain/backups', { method: 'POST' })
    showToast('Backup created', 'success')
    await loadBackups()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to create backup', 'error')
  } finally {
    creating.value = false
  }
}

async function viewDetail(ts: number) {
  try {
    detailData.value = await api<BackupDetail>(`/api/brain/backups/${ts}`)
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to load details', 'error')
  }
}

function confirmRestore(b: BackupMeta) {
  restoreTarget.value = b
}

async function doRestore() {
  if (!restoreTarget.value) return
  restoring.value = true
  try {
    await api(`/api/brain/backups/${restoreTarget.value.timestamp}/restore`, { method: 'POST' })
    showToast('Backup restored successfully', 'success')
    restoreTarget.value = null
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Restore failed', 'error')
  } finally {
    restoring.value = false
  }
}

function confirmDelete(b: BackupMeta) {
  deleteTarget.value = b
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await api(`/api/brain/backups/${deleteTarget.value.timestamp}`, { method: 'DELETE' })
    showToast('Backup deleted', 'success')
    deleteTarget.value = null
    await loadBackups()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Delete failed', 'error')
  } finally {
    deleting.value = false
  }
}

const icons = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  detail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
}

useVisibilityRefresh(loadBackups)

onMounted(loadBackups)
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

.action-bar {
  margin-bottom: 16px;
  display: flex;
  gap: 10px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-family: var(--mono);
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-dim);
  cursor: pointer;
  transition: all .15s;
}
.btn:hover { color: var(--text); border-color: var(--text-muted); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { border-color: var(--accent); color: var(--accent); }
.btn-primary:hover { background: rgba(139,92,246,0.1); }
.btn-sm { padding: 4px 10px; font-size: 11px; }
.btn-warn { border-color: var(--yellow); color: var(--yellow); }
.btn-warn:hover { background: rgba(234,179,8,0.1); }
.btn-danger { border-color: var(--red); color: var(--red); }
.btn-danger:hover { background: rgba(239,68,68,0.1); }

.backup-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.backup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: border-color .15s;
}
.backup-row:hover { border-color: var(--text-muted); }

.backup-info { flex: 1; min-width: 0; }

.backup-date {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.backup-ago {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
}

.backup-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.stat-chip {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  padding: 2px 6px;
  background: rgba(255,255,255,0.03);
  border-radius: 4px;
}

.badge {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.badge.auto {
  color: var(--green);
  background: rgba(34,197,94,0.1);
  border: 1px solid rgba(34,197,94,0.2);
}
.badge.manual {
  color: var(--accent);
  background: rgba(139,92,246,0.1);
  border: 1px solid rgba(139,92,246,0.2);
}

.backup-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.empty-hint {
  color: var(--text-ghost);
  text-align: center;
  font-size: 13px;
}

/* Detail modal */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.k {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.v {
  font-size: 14px;
  color: var(--text);
}

.detail-label {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  display: block;
  margin-bottom: 6px;
}

.type-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.type-badge {
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 8px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-dim);
}

.pinned-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pinned-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 8px;
  background: rgba(255,255,255,0.02);
  border-radius: 6px;
}
.pinned-type {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--accent);
  text-transform: uppercase;
  flex-shrink: 0;
  padding-top: 2px;
}
.pinned-content {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* Confirm modals */
.confirm-text {
  font-size: 14px;
  color: var(--text-dim);
  line-height: 1.5;
  margin-bottom: 8px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .backup-row { flex-direction: column; align-items: flex-start; }
  .backup-actions { width: 100%; justify-content: flex-end; }
  .stat-grid { grid-template-columns: 1fr 1fr; }
  .detail-grid { grid-template-columns: 1fr 1fr; }
}
</style>
