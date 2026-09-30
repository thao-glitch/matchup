/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_ICE_URL?: string;
  /** AdSense publisher + slot — when both are set, the lobby shows an ad. */
  readonly VITE_ADSENSE_CLIENT?: string;
  readonly VITE_ADSENSE_SLOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
