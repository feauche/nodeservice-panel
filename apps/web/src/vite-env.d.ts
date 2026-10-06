/// <reference types="vite/client" />

/** Версия панели из package.json, подставляется сборкой (vite `define`). В тестах может отсутствовать. */
declare const __APP_VERSION__: string | undefined;

/** Хэш коммита и дата сборки — для окна версии. */
declare const __APP_COMMIT__: string | undefined;
declare const __APP_BUILT_AT__: string | undefined;
