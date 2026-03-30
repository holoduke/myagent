<template>
  <div class="section">
    <div class="section-top">
      <LayoutSectionHeader>Agents</LayoutSectionHeader>
      <button class="add-btn" @click="openCreate">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="agents">
      <!-- Agent Tiles -->
      <div v-if="agents.length" class="agent-tiles">
        <div
          v-for="agent in agents"
          :key="agent.id"
          class="agent-tile"
          @click="openEdit(agent)"
        >
          <div class="agent-tile-icon" v-html="providerIcon(agent.provider)"></div>
          <div class="agent-tile-info">
            <div class="agent-tile-name">{{ agent.name }}</div>
            <div class="agent-tile-row">
              <span class="provider-badge" :class="agent.provider">{{ agent.provider }}</span>
              <span v-if="agent.isDefault" class="default-badge">Default</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty-hint" style="padding:40px">
        No agents configured yet. Click the <strong>+</strong> button to add one.
      </div>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>

    <!-- Create Modal: Step 1 - Pick Provider -->
    <UiModal :open="showCreate && !createProvider" title="New Agent" @close="showCreate = false">
      <p class="modal-hint">Select an AI provider:</p>
      <div class="provider-list">
        <div v-for="p in providers" :key="p.id" class="provider-item" @click="pickProvider(p.id)">
          <div class="provider-item-icon" v-html="p.icon"></div>
          <div class="provider-item-info">
            <div class="provider-item-name">{{ p.name }}</div>
            <div class="provider-item-desc">{{ p.description }}</div>
          </div>
          <svg class="provider-item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
    </UiModal>

    <!-- Create Modal: Step 2 - Configure -->
    <UiModal :open="showCreate && !!createProvider" :title="`New ${createProviderName} Agent`" @close="showCreate = false; createProvider = null">
      <div class="modal-form">
        <div class="field">
          <label>Agent Name</label>
          <input v-model="createName" type="text" :placeholder="`My ${createProviderName} Agent`" />
        </div>
        <AgentsAgentCard
          v-if="createProvider"
          :provider="createProvider"
          :config="createConfig"
          @update="createConfig = $event"
        />
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="createProvider = null">Back</button>
          <button class="btn btn-primary" :disabled="!createName.trim() || saving" @click="doCreate">
            {{ saving ? 'Creating...' : 'Create Agent' }}
          </button>
        </div>
      </div>
    </UiModal>

    <!-- Edit Modal -->
    <UiModal :open="!!editAgent" :title="editAgent?.name || 'Edit Agent'" @close="editAgent = null">
      <template v-if="editAgent">
        <div class="modal-form">
          <div class="field">
            <label>Agent Name</label>
            <input v-model="editAgent.name" type="text" />
          </div>
          <AgentsAgentCard
            :provider="editAgent.provider"
            :config="editAgent.config"
            @update="editAgent!.config = $event"
          />
          <div class="modal-actions">
            <button v-if="!editAgent.isDefault" class="btn btn-ghost" @click="doSetDefault">Set as Default</button>
            <button class="btn btn-test" :disabled="testing" @click="doTest">
              {{ testing ? 'Testing...' : 'Test Connection' }}
            </button>
            <button class="btn btn-primary" :disabled="saving" @click="doUpdate">
              {{ saving ? 'Saving...' : 'Save' }}
            </button>
          </div>
          <div v-if="testResult" class="test-result" :class="{ success: testResult.success, fail: !testResult.success }">
            <template v-if="testResult.success">
              <b>Success</b> ({{ testResult.durationMs }}ms): {{ testResult.response?.slice(0, 120) }}
            </template>
            <template v-else>
              <b>Failed</b>: {{ testResult.error }}
            </template>
          </div>
          <div class="modal-danger">
            <button class="btn btn-danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Deleting...' : 'Delete Agent' }}
            </button>
          </div>
        </div>
      </template>
    </UiModal>
  </div>
</template>

<script setup lang="ts">
import type { AgentProfile } from '~/types/aria'

const { api } = useApi()
const { showToast } = useToast()

const agents = ref<AgentProfile[] | null>(null)
const error = ref('')

// Create state
const showCreate = ref(false)
const createProvider = ref<'claude' | 'codex' | 'grok' | null>(null)
const createName = ref('')
const createConfig = ref<Record<string, unknown>>({})
const saving = ref(false)

// Edit state
const editAgent = ref<AgentProfile | null>(null)
const testing = ref(false)
const deleting = ref(false)
const testResult = ref<{ success: boolean; response?: string; error?: string; durationMs?: number } | null>(null)

const providers = [
  {
    id: 'claude' as const,
    name: 'Claude',
    description: 'Anthropic Claude Code CLI with full tool use',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/></svg>',
  },
  {
    id: 'codex' as const,
    name: 'Codex',
    description: 'OpenAI Codex CLI with code execution',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  },
  {
    id: 'grok' as const,
    name: 'Grok',
    description: 'xAI Grok CLI for fast inference',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  },
]

const createProviderName = computed(() => {
  const p = providers.find(p => p.id === createProvider.value)
  return p?.name || ''
})

function providerIcon(provider: string): string {
  return providers.find(p => p.id === provider)?.icon || ''
}

function openCreate() {
  showCreate.value = true
  createProvider.value = null
  createName.value = ''
  createConfig.value = {}
}

function pickProvider(id: 'claude' | 'codex' | 'grok') {
  createProvider.value = id
  createName.value = ''
  createConfig.value = {}
}

function openEdit(agent: AgentProfile) {
  editAgent.value = { ...agent, config: { ...agent.config } }
  testResult.value = null
}

async function doCreate() {
  if (!createProvider.value || !createName.value.trim()) return
  saving.value = true
  try {
    await api('/api/agents', {
      method: 'POST',
      body: {
        name: createName.value.trim(),
        provider: createProvider.value,
        config: createConfig.value,
        isDefault: agents.value?.length === 0,
      },
    })
    showCreate.value = false
    createProvider.value = null
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to create agent', 'error')
  } finally {
    saving.value = false
  }
}

async function doUpdate() {
  if (!editAgent.value) return
  saving.value = true
  try {
    await api(`/api/agents/${editAgent.value.id}`, {
      method: 'PUT',
      body: {
        name: editAgent.value.name,
        config: editAgent.value.config,
      },
    })
    editAgent.value = null
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to save agent', 'error')
  } finally {
    saving.value = false
  }
}

async function doSetDefault() {
  if (!editAgent.value) return
  try {
    await api(`/api/agents/${editAgent.value.id}/set-default`, { method: 'POST' })
    editAgent.value = null
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to set default agent', 'error')
  }
}

async function doTest() {
  if (!editAgent.value) return
  testing.value = true
  testResult.value = null
  try {
    // Save first so test uses latest config
    await api(`/api/agents/${editAgent.value.id}`, {
      method: 'PUT',
      body: { name: editAgent.value.name, config: editAgent.value.config },
    })
    const result = await api<{ success: boolean; response?: string; error?: string; durationMs?: number }>(
      `/api/agents/${editAgent.value.id}/test`,
      { method: 'POST' },
    )
    testResult.value = result
  } catch (e) {
    testResult.value = { success: false, error: e instanceof Error ? e.message : 'Unknown error' }
  } finally {
    testing.value = false
  }
}

async function doDelete() {
  if (!editAgent.value || !confirm(`Delete agent "${editAgent.value.name}"?`)) return
  deleting.value = true
  try {
    await api(`/api/agents/${editAgent.value.id}`, { method: 'DELETE' })
    editAgent.value = null
    await load()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to delete agent', 'error')
  } finally {
    deleting.value = false
  }
}

async function load() {
  try {
    agents.value = await api<AgentProfile[]>('/api/agents')
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

useVisibilityRefresh(load)

onMounted(load)
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

.section-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.section-top :deep(.section-header) {
  margin-bottom: 0;
}

.add-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all .2s;
}
.add-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: var(--glow-accent);
}
.add-btn svg {
  width: 18px;
  height: 18px;
}

/* ── Agent Tiles ── */
.agent-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.agent-tile {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  transition: all .2s;
}
.agent-tile:hover {
  border-color: var(--border-glow);
  box-shadow: var(--glow-card);
}
.agent-tile-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
}
.agent-tile-icon :deep(svg) {
  width: 32px;
  height: 32px;
}
.agent-tile-info {
  flex: 1;
  min-width: 0;
}
.agent-tile-name {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
}
.agent-tile-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.provider-badge {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.provider-badge.claude { background: rgba(168,85,247,0.15); color: #a855f7; }
.provider-badge.codex { background: rgba(16,185,129,0.15); color: #10b981; }
.provider-badge.grok { background: rgba(245,158,11,0.15); color: #f59e0b; }
.default-badge {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(168,85,247,0.1);
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ── Modals ── */
.modal-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: all .2s;
}
.provider-item:hover {
  border-color: var(--border-glow);
  background: var(--bg-card);
  box-shadow: var(--glow-card);
}
.provider-item-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}
.provider-item-icon :deep(svg) {
  width: 28px;
  height: 28px;
}
.provider-item-info {
  flex: 1;
  min-width: 0;
}
.provider-item-name {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
}
.provider-item-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.provider-item-arrow {
  width: 16px;
  height: 16px;
  color: var(--text-ghost);
  flex-shrink: 0;
  transition: color .2s;
}
.provider-item:hover .provider-item-arrow {
  color: var(--accent);
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.field input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  transition: border-color .15s;
}
.field input:focus {
  border-color: var(--accent);
}
.field input::placeholder {
  color: var(--text-ghost);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}

.btn {
  padding: 8px 16px;
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
  transition: all .15s;
  border: 1px solid var(--border);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-ghost {
  background: transparent;
  color: var(--text-muted);
}
.btn-ghost:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-glow);
}
.btn-primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.btn-primary:hover:not(:disabled) {
  box-shadow: var(--glow-accent);
}
.btn-test {
  background: transparent;
  color: var(--text-muted);
}
.btn-test:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.btn-danger {
  background: transparent;
  color: var(--red);
  border-color: var(--red);
}
.btn-danger:hover:not(:disabled) {
  background: rgba(239,68,68,0.1);
}

.test-result {
  padding: 10px 14px;
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
}
.test-result.success {
  background: rgba(16,185,129,0.1);
  color: #10b981;
  border: 1px solid rgba(16,185,129,0.2);
}
.test-result.fail {
  background: rgba(239,68,68,0.1);
  color: var(--red);
  border: 1px solid rgba(239,68,68,0.2);
}

.modal-danger {
  padding-top: 12px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
}

.empty-hint {
  color: var(--text-ghost);
  text-align: center;
  font-size: 14px;
}
.empty-hint strong {
  color: var(--accent);
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .agent-tiles { grid-template-columns: 1fr; }
}
</style>
