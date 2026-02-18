import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark-dimmed.css'

export default defineNuxtPlugin(() => {
  marked.use(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code: string, lang: string) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value
        }
        return hljs.highlightAuto(code).value
      },
    }),
    { breaks: true, gfm: true },
  )

  return {
    provide: {
      marked: (content: string) => marked.parse(content) as string,
    },
  }
})
