export default defineNuxtConfig({
  compatibilityDate: '2026-02-18',
  modules: ['@pinia/nuxt'],

  css: [
    '~/assets/css/tokens.css',
    '~/assets/css/global.css',
    '~/assets/css/components.css',
  ],

  app: {
    head: {
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover',
      title: 'ARIA Mainframe',
      meta: [
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'theme-color', content: '#07070f' },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
      link: [
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Mono:wght@400;700&display=swap' },
      ],
    },
  },

  runtimeConfig: {
    apiUrl: process.env.API_URL || 'http://localhost:3000',
  },

  nitro: {
    routeRules: {
      '/**': {
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'X-XSS-Protection': '0',
        },
      },
    },
  },

  devtools: { enabled: false },
})
