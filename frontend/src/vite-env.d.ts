/// <reference types="vite/client" />
//
// 为什么需要这个文件
// ------------------
// tsconfig.json 的 include 只覆盖 src 下的 .ts / .tsx / .vue，而 Vite 注入的
// `import.meta.env` 以及 `*.css` 这类副作用导入（如 ant-design-vue/dist/reset.css）
// 的类型声明来自 `vite/client`。
// 缺少这三行引用时，`vue-tsc` 会报两类错：
//   TS2339  Property 'env' does not exist on type 'ImportMeta'
//   TS2307  Cannot find module 'ant-design-vue/dist/reset.css'
// 即 `npm run build` 直接失败——构建脚本是 `vue-tsc && vite build`，前者不通过不会产出。
//
// 环境变量的类型声明：让 `import.meta.env.VITE_*` 有具体类型，
// 拼错变量名时能在编译期被发现，而不是运行时拿到 undefined。

interface ImportMetaEnv {
  /** 高德 Web 服务 Key（供后端/静态图等使用） */
  readonly VITE_AMAP_WEB_KEY?: string
  /** 高德 Web 端 JS API Key（供浏览器端地图使用） */
  readonly VITE_AMAP_WEB_JS_KEY?: string
  /** 后端地址，未设置时走 dev 代理 */
  readonly VITE_API_BASE_URL?: string
  readonly MODE: string
  readonly DEV: boolean
  readonly PROD: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
