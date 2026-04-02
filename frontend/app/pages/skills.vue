<template>
  <div class="section">
    <div class="section-top">
      <LayoutSectionHeader>Skills</LayoutSectionHeader>
      <button class="add-btn" @click="openCreate">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'catalog' }" @click="tab = 'catalog'">Catalog</button>
      <button class="tab" :class="{ active: tab === 'installed' }" @click="tab = 'installed'">
        Installed
        <span v-if="installed?.length" class="tab-count">{{ installed.length }}</span>
      </button>
    </div>

    <!-- ═══ Catalog Tab ═══ -->
    <template v-if="tab === 'catalog'">
      <div v-if="catalogError" class="card">
        <p style="color:var(--red)">Failed to load catalog: {{ catalogError }}</p>
      </div>

      <template v-else-if="catalog">
        <div v-for="cat in catalogByCategory" :key="cat.category" class="catalog-group">
          <div class="catalog-category">{{ cat.category }}</div>
          <div class="skill-tiles">
            <div
              v-for="skill in cat.skills"
              :key="skill.id"
              class="skill-tile"
              :class="{ installed: skill.installed }"
              @click="previewCatalog(skill)"
            >
              <div class="skill-tile-icon" v-html="iconSvg(skill.icon)"></div>
              <div class="skill-tile-info">
                <div class="skill-tile-name">{{ skill.name }}</div>
                <div class="skill-tile-desc">{{ skill.description }}</div>
                <div class="skill-tile-row">
                  <span v-if="skill.installed" class="skill-status on">Installed</span>
                  <span v-else class="skill-status available">Available</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!catalog.length" class="empty-hint" style="padding:40px">
          No catalog skills available.
        </div>
      </template>

      <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading catalog...</div>
    </template>

    <!-- ═══ Installed Tab ═══ -->
    <template v-if="tab === 'installed'">
      <div v-if="installedError" class="card">
        <p style="color:var(--red)">Failed to load: {{ installedError }}</p>
      </div>

      <template v-else-if="installed">
        <div v-if="installed.length" class="skill-tiles" style="margin-top:16px">
          <div
            v-for="skill in installed"
            :key="skill.id"
            class="skill-tile"
            @click="openEdit(skill)"
          >
            <div class="skill-tile-icon" v-html="iconSvg(skill.icon)"></div>
            <div class="skill-tile-info">
              <div class="skill-tile-name">{{ skill.name }}</div>
              <div class="skill-tile-desc">{{ skill.description || 'No description' }}</div>
              <div class="skill-tile-row">
                <span class="skill-cat">{{ skill.category }}</span>
                <span class="skill-status" :class="skill.enabled ? 'on' : 'off'">
                  {{ skill.enabled ? 'Enabled' : 'Disabled' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="empty-hint" style="padding:40px">
          No skills installed yet. Browse the <strong>Catalog</strong> to install skills, or click <strong>+</strong> to create a custom one.
        </div>
      </template>

      <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
    </template>

    <!-- ═══ Catalog Preview Modal ═══ -->
    <UiModal :open="!!previewSkill" :title="previewSkill?.name || 'Skill'" @close="previewSkill = null">
      <template v-if="previewSkill">
        <div class="modal-form">
          <div class="preview-meta">
            <span class="skill-cat">{{ previewSkill.category }}</span>
            <span v-if="previewSkill.installed" class="skill-status on">Installed</span>
          </div>
          <p class="preview-desc">{{ previewSkill.description }}</p>
          <div class="field">
            <label>Prompt Template</label>
            <pre class="preview-prompt">{{ previewSkill.prompt }}</pre>
          </div>
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="previewSkill = null">Close</button>
            <button
              v-if="!previewSkill.installed"
              class="btn btn-primary"
              :disabled="installing"
              @click="doInstall(previewSkill)"
            >
              {{ installing ? 'Installing...' : 'Install Skill' }}
            </button>
            <button
              v-else
              class="btn btn-danger"
              :disabled="installing"
              @click="doUninstall(previewSkill)"
            >
              {{ installing ? 'Removing...' : 'Uninstall' }}
            </button>
          </div>
        </div>
      </template>
    </UiModal>

    <!-- ═══ Create Custom Modal ═══ -->
    <UiModal :open="showCreate" title="New Custom Skill" @close="showCreate = false">
      <div class="modal-form">
        <div class="field">
          <label>Name</label>
          <input v-model="createForm.name" type="text" placeholder="e.g. Web Research" />
        </div>
        <div class="field">
          <label>Description</label>
          <input v-model="createForm.description" type="text" placeholder="What does this skill do?" />
        </div>
        <div class="field">
          <label>Category</label>
          <input v-model="createForm.category" type="text" placeholder="e.g. Research, Development, Productivity" />
        </div>
        <div class="field">
          <label>Prompt Template</label>
          <textarea v-model="createForm.prompt" rows="6" placeholder="The prompt instructions for this skill..."></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="showCreate = false">Cancel</button>
          <button class="btn btn-primary" :disabled="!createForm.name.trim() || !createForm.prompt.trim() || saving" @click="doCreate">
            {{ saving ? 'Creating...' : 'Create Skill' }}
          </button>
        </div>
      </div>
    </UiModal>

    <!-- ═══ Edit Installed Modal ═══ -->
    <UiModal :open="!!editSkill" :title="editSkill?.name || 'Edit Skill'" @close="editSkill = null">
      <template v-if="editSkill">
        <div class="modal-form">
          <div class="field">
            <label>Name</label>
            <input v-model="editSkill.name" type="text" />
          </div>
          <div class="field">
            <label>Description</label>
            <input v-model="editSkill.description" type="text" />
          </div>
          <div class="field">
            <label>Prompt Template</label>
            <textarea v-model="editSkill.prompt" rows="8"></textarea>
          </div>
          <div class="field-row">
            <label>Enabled</label>
            <button class="toggle-btn" :class="{ active: editSkill.enabled }" @click="editSkill!.enabled = !editSkill!.enabled">
              {{ editSkill.enabled ? 'Yes' : 'No' }}
            </button>
          </div>
          <div class="modal-actions">
            <button class="btn btn-primary" :disabled="!editSkill.name.trim() || !editSkill.prompt.trim() || saving" @click="doUpdate">
              {{ saving ? 'Saving...' : 'Save' }}
            </button>
          </div>
          <div class="modal-danger">
            <button class="btn btn-danger" :disabled="deleting" @click="doDelete">
              {{ deleting ? 'Deleting...' : 'Delete Skill' }}
            </button>
          </div>
        </div>
      </template>
    </UiModal>
  </div>
</template>

<script setup lang="ts">
import type { Skill, CatalogSkill } from '~/types/aria'

const { api } = useApi()
const { showToast } = useToast()

const tab = ref<'catalog' | 'installed'>('catalog')

// ── Catalog state ──
const catalog = ref<CatalogSkill[] | null>(null)
const catalogError = ref('')
const previewSkill = ref<CatalogSkill | null>(null)
const installing = ref(false)

// ── Installed state ──
const installed = ref<Skill[] | null>(null)
const installedError = ref('')

// ── Create state ──
const showCreate = ref(false)
const createForm = ref({ name: '', description: '', category: '', prompt: '' })
const saving = ref(false)

// ── Edit state ──
const editSkill = ref<Skill | null>(null)
const deleting = ref(false)

// ── Computed ──
const catalogByCategory = computed(() => {
  if (!catalog.value) return []
  const groups: Record<string, CatalogSkill[]> = {}
  for (const skill of catalog.value) {
    const cat = skill.category || 'Other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(skill)
  }
  return Object.entries(groups).map(([category, skills]) => ({ category, skills }))
})

// ── Icon helper ──
const ICON_MAP: Record<string, string> = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  'file-text': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
  'book-open': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
}

function iconSvg(icon: string): string {
  return ICON_MAP[icon] || ICON_MAP.star
}

// ── Actions ──
function openCreate() {
  showCreate.value = true
  createForm.value = { name: '', description: '', category: '', prompt: '' }
}

function openEdit(skill: Skill) {
  editSkill.value = { ...skill }
}

function previewCatalog(skill: CatalogSkill) {
  previewSkill.value = { ...skill }
}

async function doInstall(skill: CatalogSkill) {
  installing.value = true
  try {
    await api(`/api/skills/catalog/${skill.id}/install`, { method: 'POST' })
    showToast(`Installed "${skill.name}"`, 'success')
    previewSkill.value = null
    await loadAll()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to install', 'error')
  } finally {
    installing.value = false
  }
}

async function doUninstall(skill: CatalogSkill) {
  installing.value = true
  try {
    await api(`/api/skills/catalog/${skill.id}/uninstall`, { method: 'POST' })
    showToast(`Uninstalled "${skill.name}"`, 'success')
    previewSkill.value = null
    await loadAll()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to uninstall', 'error')
  } finally {
    installing.value = false
  }
}

async function doCreate() {
  if (!createForm.value.name.trim() || !createForm.value.prompt.trim()) return
  saving.value = true
  try {
    await api('/api/skills', {
      method: 'POST',
      body: createForm.value,
    })
    showCreate.value = false
    tab.value = 'installed'
    await loadAll()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to create skill', 'error')
  } finally {
    saving.value = false
  }
}

async function doUpdate() {
  if (!editSkill.value) return
  saving.value = true
  try {
    await api(`/api/skills/${editSkill.value.id}`, {
      method: 'PUT',
      body: {
        name: editSkill.value.name,
        description: editSkill.value.description,
        prompt: editSkill.value.prompt,
        enabled: editSkill.value.enabled,
      },
    })
    editSkill.value = null
    await loadAll()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to save skill', 'error')
  } finally {
    saving.value = false
  }
}

async function doDelete() {
  if (!editSkill.value || !confirm(`Delete skill "${editSkill.value.name}"?`)) return
  deleting.value = true
  try {
    await api(`/api/skills/${editSkill.value.id}`, { method: 'DELETE' })
    editSkill.value = null
    await loadAll()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to delete skill', 'error')
  } finally {
    deleting.value = false
  }
}

// ── Loading ──
async function loadCatalog() {
  try {
    catalog.value = await api<CatalogSkill[]>('/api/skills/catalog')
    catalogError.value = ''
  } catch (e) {
    catalogError.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

async function loadInstalled() {
  try {
    installed.value = await api<Skill[]>('/api/skills')
    installedError.value = ''
  } catch (e) {
    installedError.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

async function loadAll() {
  await Promise.all([loadCatalog(), loadInstalled()])
}

useVisibilityRefresh(loadAll)
onMounted(loadAll)
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
.add-btn svg { width: 18px; height: 18px; }

/* ── Tabs ── */
.tabs {
  display: flex;
  gap: 2px;
  margin: 16px 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 3px;
}
.tab {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: all .15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.tab:hover { color: var(--text); }
.tab.active {
  background: var(--bg-card);
  color: var(--accent);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1);
}
.tab-count {
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  line-height: 1.4;
}

/* ── Catalog ── */
.catalog-group {
  margin-bottom: 24px;
}
.catalog-category {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 10px;
}

/* ── Skill Tiles ── */
.skill-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.skill-tile {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  transition: all .2s;
}
.skill-tile:hover {
  border-color: var(--border-glow);
  box-shadow: var(--glow-card);
}
.skill-tile.installed {
  border-color: rgba(34,197,94,0.2);
}
.skill-tile-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: var(--accent);
}
.skill-tile-icon :deep(svg) { width: 32px; height: 32px; }
.skill-tile-info {
  flex: 1;
  min-width: 0;
}
.skill-tile-name {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
}
.skill-tile-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.skill-tile-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.skill-cat {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 1px;
  background: rgba(168,85,247,0.1);
  color: var(--accent);
}
.skill-status {
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.skill-status.on {
  background: rgba(34,197,94,0.1);
  color: #22c55e;
}
.skill-status.off {
  background: rgba(239,68,68,0.1);
  color: #ef4444;
}
.skill-status.available {
  background: rgba(168,85,247,0.1);
  color: var(--accent);
}

/* ── Preview Modal ── */
.preview-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview-desc {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}
.preview-prompt {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 11px;
  padding: 12px;
  line-height: 1.5;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* ── Modals ── */
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
.field input,
.field textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  transition: border-color .15s;
  resize: vertical;
}
.field input:focus,
.field textarea:focus {
  border-color: var(--accent);
}
.field input::placeholder,
.field textarea::placeholder {
  color: var(--text-ghost);
}

.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.field-row label {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.toggle-btn {
  padding: 4px 14px;
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  transition: all .15s;
}
.toggle-btn.active {
  background: rgba(34,197,94,0.1);
  color: #22c55e;
  border-color: rgba(34,197,94,0.3);
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
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
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
.btn-danger {
  background: transparent;
  color: var(--red);
  border-color: var(--red);
}
.btn-danger:hover:not(:disabled) {
  background: rgba(239,68,68,0.1);
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
.empty-hint strong { color: var(--accent); }

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .skill-tiles { grid-template-columns: 1fr; }
}
</style>
