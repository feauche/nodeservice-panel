/// <reference types="vite/client" />

/** Версия панели из package.json, подставляется сборкой (vite `define`). В тестах может отсутствовать. */
declare const __APP_VERSION__: string | undefined;
