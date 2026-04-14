/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
  readonly VITE_RUM_APP_MONITOR_ID?: string;
  readonly VITE_RUM_GUEST_ROLE_ARN?: string;
  readonly VITE_RUM_IDENTITY_POOL_ID?: string;
  readonly VITE_RUM_REGION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
