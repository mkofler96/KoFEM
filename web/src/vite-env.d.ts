/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GIT_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
