<template>
  <div class="app-layout">
    <LayoutSidebar />
    <div class="main-content">
      <slot />
    </div>
    <LayoutMobileNav />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100dvh;
}
.main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
