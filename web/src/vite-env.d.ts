/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GIT_VERSION?: string;
  // Google Analytics (GA4) measurement ID, e.g. "G-XXXXXXXXXX". When unset,
  // analytics and the cookie-consent banner are omitted from the build.
  readonly VITE_GA_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
