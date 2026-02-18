export function useTimeAgo() {
  function timeAgo(ts: number | undefined | null): string {
    if (!ts) return 'never'
    const d = Date.now() - ts
    const s = Math.floor(d / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    const dy = Math.floor(h / 24)
    if (s < 60) return s + 's ago'
    if (m < 60) return m + 'm ago'
    if (h < 24) return h + 'h ' + (m % 60) + 'm ago'
    return dy + 'd ago'
  }

  function fmtDate(ts: number | undefined | null): string {
    if (!ts) return 'N/A'
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  function fmtTime(ts: number | undefined | null): string {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (d.toDateString() === now.toDateString()) return time
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
  }

  return { timeAgo, fmtDate, fmtTime }
}
