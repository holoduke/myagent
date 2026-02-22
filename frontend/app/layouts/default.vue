<template>
  <div class="app-layout">
    <LayoutSidebar />
    <div class="main-content">
      <slot />
    </div>
    <LayoutMobileNav />
    <UiToast />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100dvh;
}
.main-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
@media (max-width: 768px) {
  .app-layout {
    flex-direction: column;
  }
}
</style>
