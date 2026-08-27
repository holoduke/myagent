import { defineStore } from 'pinia'
import type { ChatMessage, ChatStats } from '~/types/aria'

export const useChatStore = defineStore('chat', () => {
  const messages = ref<ChatMessage[]>([])
  const streaming = ref(false)
  const streamContent = ref('')
  const streamPhase = ref<'idle' | 'queued' | 'streaming'>('idle')
  const totalTokens = ref(0)
  const totalCost = ref(0)
  const messageCount = ref(0)
  const historyLoaded = ref(false)

  function addMessage(msg: ChatMessage) {
    messages.value.push(msg)
  }

  function clearMessages() {
    messages.value = []
    totalTokens.value = 0
    totalCost.value = 0
    messageCount.value = 0
  }

  function addStats(stats: ChatStats) {
    totalTokens.value += (stats.inputTokens || 0) + (stats.outputTokens || 0)
    totalCost.value += stats.totalCostUsd || 0
    messageCount.value++
  }

  async function loadHistory(force = false) {
    if (historyLoaded.value && !force) return

    try {
      const data = await $fetch<ChatMessage[]>('/api/history')
      if (data && data.length) {
        totalTokens.value = 0
        totalCost.value = 0
        messageCount.value = 0

        const next: ChatMessage[] = []
        for (const m of data) {
          next.push(m)
          if (m.role === 'assistant' && m.stats) {
            addStats(m.stats)
          }
        }
        messages.value = next
      }
    } catch {
      // Allow retry on next mount/visibility change
      return
    }

    historyLoaded.value = true
  }

  async function streamResponse(text: string): Promise<void> {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })

    if (res.status === 401) {
      addMessage({ role: 'error', content: 'Session expired', timestamp: Date.now() })
      streaming.value = false
      streamPhase.value = 'idle'
      const { logout } = useAuth()
      logout()
      return
    }

    if (!res.body) {
      addMessage({ role: 'error', content: 'Empty response from server', timestamp: Date.now() })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let lastStats: ChatStats | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const ev = JSON.parse(line.slice(6))

          if (ev.type === 'delta') {
            streamPhase.value = 'streaming'
            streamContent.value += ev.text
          } else if (ev.type === 'queued') {
            streamPhase.value = 'queued'
          } else if (ev.type === 'start') {
            streamPhase.value = 'streaming'
            streamContent.value = ''
          } else if (ev.type === 'done') {
            lastStats = ev.stats || null
          } else if (ev.type === 'error') {
            addMessage({ role: 'error', content: ev.error, timestamp: Date.now() })
          }
        } catch {
          // Skip malformed events
        }
      }
    }

    // Finalize assistant message
    if (streamContent.value) {
      const msg: ChatMessage = {
        role: 'assistant',
        content: streamContent.value,
        timestamp: Date.now(),
        source: 'web',
        stats: lastStats || undefined,
      }
      addMessage(msg)
      if (lastStats) addStats(lastStats)
    }
  }

  async function sendMessage(text: string) {
    if (streaming.value) return

    // Add user message
    addMessage({
      role: 'user',
      content: text,
      timestamp: Date.now(),
      source: 'web',
    })

    streaming.value = true
    streamContent.value = ''
    streamPhase.value = 'queued'

    try {
      await streamResponse(text)
    } catch (err) {
      // Preserve any partial content received before the drop
      const partialContent = streamContent.value

      // Retry once after 1 second
      try {
        streamContent.value = partialContent
        streamPhase.value = 'queued'
        await new Promise(resolve => setTimeout(resolve, 1000))
        await streamResponse(text)
      } catch (retryErr) {
        // If we got partial content before both failures, preserve it
        if (partialContent) {
          addMessage({
            role: 'assistant',
            content: partialContent,
            timestamp: Date.now(),
            source: 'web',
          })
        }
        addMessage({
          role: 'error',
          content: 'Connection error: ' + (retryErr instanceof Error ? retryErr.message : 'Unknown'),
          timestamp: Date.now(),
        })
      }
    } finally {
      streaming.value = false
      streamContent.value = ''
      streamPhase.value = 'idle'
    }
  }

  async function resetChat() {
    if (streaming.value) return

    streaming.value = true
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '/reset' }),
      })
      if (res.body) {
        const reader = res.body.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
      clearMessages()
      addMessage({ role: 'system', content: 'Session reset. Starting fresh.', timestamp: Date.now() })
    } catch {
      addMessage({ role: 'error', content: 'Failed to reset', timestamp: Date.now() })
    } finally {
      streaming.value = false
    }
  }

  return {
    messages,
    streaming,
    streamContent,
    streamPhase,
    totalTokens,
    totalCost,
    messageCount,
    historyLoaded,
    addMessage,
    clearMessages,
    loadHistory,
    sendMessage,
    resetChat,
  }
})
