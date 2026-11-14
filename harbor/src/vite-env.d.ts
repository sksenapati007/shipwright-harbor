/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** true only in dev / test / e2e builds (vite.config.ts); false in a release build so FakeDevice is tree-shaken out. */
declare const __HARBOR_FAKE__: boolean;
