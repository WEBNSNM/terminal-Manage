import { createRouter, createWebHashHistory } from 'vue-router'
// 引入你的组件
import Dashboard from '../views/dashboard/index.vue'
import WeeklyReport from '../views/weekly-report/index.vue'

const routes = [
  {
    path: '/',
    redirect: '/dashboard'
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: Dashboard
  },
  {
    path: '/weekly-report',
    name: 'WeeklyReport',
    component: WeeklyReport
  },
  {
    path: '/disk-cleaner',
    name: 'DiskCleaner',
    component: () => import('../views/disk-cleaner/index.vue')
  },
]

const router = createRouter({
  // Electron 推荐用 Hash 模式 (URL带#)，避免打包后路径找不到
  history: createWebHashHistory(),
  routes
})

export default router
