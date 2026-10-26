import { type Ref } from 'vue';
import type { PiniaPlugin } from 'pinia';
import type { MaxPiniaConfig, Status } from './types';
export declare function buildUrl(url: string, params?: Record<string, any>): string;
/**
 * Cria o plugin do Pinia. A config injeta tudo que é específico do app
 * (axios, token de sessão, adapter de loading), mantendo o pacote desacoplado.
 *
 * @example
 * ```ts
 * import { createMaxPinia } from '@maxvue/max-pinia';
 * pinia.use(createMaxPinia({
 *     getSessionToken: () => useSystemStore().session_token,
 *     isAppStarted:    () => useSystemStore().started,
 *     loading: {
 *         start:  (o) => useLoadingStore().start(o),
 *         stop:   (k) => useLoadingStore().stop(k),
 *         update: (o) => useLoadingStore().update(o),
 *     },
 * }));
 * ```
 */
export declare function createMaxPinia(userConfig?: MaxPiniaConfig): PiniaPlugin;
/** Hook utilitário: observa o status agregado emitido por qualquer store cacheada. */
export declare function useAsyncStatus(): Ref<Status | null>;
//# sourceMappingURL=plugin.d.ts.map