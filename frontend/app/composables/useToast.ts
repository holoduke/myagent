type ToastType = 'success' | 'error' | 'info'

interface Toast {
  id: number
  message: string
  type: ToastType
  duration: number
}

const toasts = ref<Toast[]>([])
let nextId = 0

export function useToast() {
  function showToast(message: string, type: ToastType = 'info', duration = 5000) {
    const id = nextId++
    toasts.value.push({ id, message, type, duration })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }

  return { toasts, showToast }
}
