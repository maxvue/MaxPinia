import { ref, computed, watch, nextTick, toValue, toRaw, isRef, getCurrentScope, onScopeDispose, type Ref } from 'vue';
import type { PiniaPlugin, PiniaPluginContext } from 'pinia';
import localforage from 'localforage';
import { cloneDeep, size, isEqual, unset } from 'lodash-es';
import { watchDebounced } from '@vueuse/core';

import type { MaxPiniaConfig, Status } from './types';
import { useDefaultReset, watchValid, getIn, anyIsFalseIn, isNotEmpty } from './helpers/internal';

const isBlank = (v: any): boolean => !isNotEmpty(v);

export function buildUrl(url: string, params?: Record<string, any>): string {
    if (!params || Object.keys(params).length === 0) return url;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) qs.append(k, String(v));
    const str = qs.toString();
    if (!str) return url;

    const hashIndex = url.indexOf('#');
    const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
    const baseUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;

    const hasQuery = baseUrl.includes('?');
    const separator = hasQuery
        ? (baseUrl.endsWith('?') || baseUrl.endsWith('&') ? '' : '&')
        : '?';

    return `${baseUrl}${separator}${str}${hash}`;
}

interface ResolvedConfig extends Required<Omit<MaxPiniaConfig, 'loading'>> {
    loading: NonNullable<MaxPiniaConfig['loading']>;
}

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
export function createMaxPinia(userConfig: MaxPiniaConfig = {}): PiniaPlugin {
    let resolved: ResolvedConfig | null = null;

    const resolve = async (): Promise<ResolvedConfig> => {
        if (resolved) return resolved;
        const axiosInstance = userConfig.axios ?? (await import('axios')).default;
        resolved = {
            cacheName: userConfig.cacheName ?? 'pinia',
            axios: axiosInstance,
            getSessionToken: userConfig.getSessionToken ?? (() => null),
            isAppStarted: userConfig.isAppStarted ?? (() => true),
            requestTimeout: userConfig.requestTimeout ?? 15000,
            storeName: userConfig.storeName ?? 'max-pinia-cache',
            resolveRoute: userConfig.resolveRoute ?? buildUrl,
            onActivity: userConfig.onActivity ?? (() => {}),
            loading: userConfig.loading ?? {}
        };
        return resolved;
    };

    return (context: PiniaPluginContext) => {
        // Resolve config de forma síncrona quando possível; axios é carregado lazy.
        const cfg: ResolvedConfig = {
            cacheName: userConfig.cacheName ?? 'pinia',
            axios: userConfig.axios as any,
            getSessionToken: userConfig.getSessionToken ?? (() => null),
            isAppStarted: userConfig.isAppStarted ?? (() => true),
            requestTimeout: userConfig.requestTimeout ?? 15000,
            storeName: userConfig.storeName ?? 'max-pinia-cache',
            resolveRoute: userConfig.resolveRoute ?? buildUrl,
            onActivity: userConfig.onActivity ?? (() => {}),
            loading: userConfig.loading ?? {}
        };
        const getAxios = async () => cfg.axios ?? (await resolve()).axios;
        return maxPiniaPlugin(context, cfg, getAxios);
    };
}

function maxPiniaPlugin(
    context: PiniaPluginContext,
    cfg: ResolvedConfig,
    getAxios: () => Promise<any>
) {
    const store = context.store;

    if (!store.isCached && !store.is_cached) return {};

    const cache_name: Ref = isRef(store.cache_name) ? store.cache_name : ref(store.cache_name ?? store.options?.cache_name ?? store.options?.cacheName ?? cfg.cacheName);
    const store_name = toValue(store.storeName) ?? toValue(store.store_name) ?? store.options?.storeName ?? store.options?.store_name ?? cfg.storeName;

    // Criação de instância isolada de LocalForage por store com fallback defensivo para mocks legados
    const storage: any = typeof localforage.createInstance === 'function'
        ? localforage.createInstance({ name: cache_name.value, storeName: store_name })
        : (localforage.config({ name: cache_name.value, storeName: store_name }), localforage);

    const loading = cfg.loading;
    const userDefault = getIn(store, ['default_value', 'default_data', 'defaultData', 'dataDefault', 'data_default', 'default']) ?? store.data;
    const default_value = ref(cloneDeep(toRaw(userDefault)));

    store.data = {};

    const idx: Ref = ref(false);

    const key = computed(() => store.$id + '.' + (store?.id ?? store.options?.id ?? 'global'));
    const getKey = (): string => store.$id + '.' + (store?.id ?? store.options?.id ?? 'global');
    const getIncludes = () => getIn(store, ['includeCache', 'includeInCache', 'inCache', 'options.includeInCache', 'options.inCache', 'options.includeCache', 'cacheInclude', 'options.cacheInclude', 'options.saveInCache']);
    const checkOnlyCache = () => store.only_cache ?? store.options?.only_cache ?? store.cache_only ?? store.options?.cache_only ?? false;
    const getInDeduplication = () => store?.in_deduplication ?? store?.options?.in_deduplication ?? store?.in_get_deduplication ?? store?.options?.in_get_deduplication ?? 'last';
    const getRouteName = (): string | null => getIn(store, ['options.get.route', 'options.get.get', 'options.get', 'options.get_route', 'options.route_get', 'options.route']);
    const getRouteData = () => {
        const source = store?.get_data ?? store?.data_get ?? store?.options?.get?.data ?? {};
        const data_return: Record<string, any> = {};
        for (const k in source) data_return[k] = toValue(source[k]);
        return data_return;
    };

    interface ReadIdentity {
        generation: number;
        key: string;
        routeName: string | null;
        routeData: Record<string, any>;
    }

    let isDisposed = false;
    let identityGeneration = 0;
    let serverRequestSequence = 0;
    let activeServerRequestSequence = 0;
    let cacheRequestSequence = 0;
    let activeCacheRequestSequence = 0;
    let postRequestSequence = 0;
    let activePostRequestSequence = 0;
    let cacheSaveSequence = 0;
    let activeCacheSaveSequence = 0;

    const captureReadIdentity = (): ReadIdentity => ({
        generation: identityGeneration,
        key: getKey(),
        routeName: getRouteName(),
        routeData: cloneDeep(toRaw(getRouteData()))
    });

    const isReadIdentityCurrent = (identity: ReadIdentity): boolean =>
        !isDisposed
        && identity.generation === identityGeneration
        && identity.key === getKey()
        && identity.routeName === getRouteName()
        && isEqual(identity.routeData, getRouteData())
        && store.enabled !== false
        && store.options?.enabled !== false;

    interface PostIdentity {
        generation: number;
        key: string;
        routeName: string | null;
    }

    const capturePostIdentity = (): PostIdentity => ({
        generation: identityGeneration,
        key: getKey(),
        routeName: postRouteName()
    });

    const isPostIdentityCurrent = (identity: PostIdentity): boolean =>
        !isDisposed
        && identity.generation === identityGeneration
        && identity.key === getKey()
        && identity.routeName === postRouteName()
        && store.enabled !== false
        && store.options?.enabled !== false;

    const resolveDefaultData = () => {
        const val = getIn(store, ['default_data', 'defaultData', 'dataDefault', 'data_default', 'default']) ?? default_value.value ?? {};
        return cloneDeep(toRaw(val));
    };
    const setDefaultData = () => {
        store.data = resolveDefaultData();
    };

    const signal_get_request: Ref = ref(null);
    const progress_loading: Ref = ref(null);

    const status = useDefaultReset<Status>({
        server: {
            get: { is_requesting: false, is_requesting_now: false, is_requested: false, is_blank: false, is_success: false, is_success_now: false, is_error: false, error: null },
            save: { is_requesting: false, is_requesting_now: false, is_requested: false, is_success: false, is_success_now: false, is_error: false, error: null } },
        cache: {
            get: { is_requesting: false, is_requesting_now: false, is_requested: false, is_blank: false, is_success: false, is_success_now: false, is_error: false, error: null },
            save: { is_requesting: false, is_requesting_now: false, is_requested: false, is_success: false, is_success_now: false, is_error: false, error: null } }
    }) as any;

    let timer_server_get: ReturnType<typeof setTimeout> | null = null;
    let timer_server_save: ReturnType<typeof setTimeout> | null = null;
    let timer_cache_get: ReturnType<typeof setTimeout> | null = null;
    let timer_cache_save: ReturnType<typeof setTimeout> | null = null;

    const clearStatusTimers = () => {
        if (timer_server_get) {
            clearTimeout(timer_server_get);
            timer_server_get = null;
        }
        if (timer_server_save) {
            clearTimeout(timer_server_save);
            timer_server_save = null;
        }
        if (timer_cache_get) {
            clearTimeout(timer_cache_get);
            timer_cache_get = null;
        }
        if (timer_cache_save) {
            clearTimeout(timer_cache_save);
            timer_cache_save = null;
        }
    };

    const originalStatusReset = status.reset;
    const attachResetMethod = () => {
        if (status.value && typeof status.value === 'object') {
            Object.defineProperty(status.value, 'reset', {
                value: () => {
                    status.reset();
                },
                writable: true,
                configurable: true
            });
        }
    };
    attachResetMethod();

    status.reset = () => {
        clearStatusTimers();
        originalStatusReset();
        attachResetMethod();
    };

    const trigger_server_get = ref(0);
    const trigger_server_save = ref(0);
    const trigger_cache_get = ref(0);
    const trigger_cache_save = ref(0);

    watch(
        () => [
            status.value,
            status.value?.server?.get?.is_requesting,
            status.value?.server?.get?.is_requesting_now,
            status.value?.server?.get?.is_requested,
            status.value?.server?.get?.is_blank,
            status.value?.server?.get?.is_success,
            status.value?.server?.get?.is_success_now,
            status.value?.server?.get?.is_error,
            status.value?.server?.get?.error,
            status.value?.server?.save?.is_requesting,
            status.value?.server?.save?.is_requesting_now,
            status.value?.server?.save?.is_requested,
            status.value?.server?.save?.is_success,
            status.value?.server?.save?.is_success_now,
            status.value?.server?.save?.is_error,
            status.value?.server?.save?.error,
            status.value?.cache?.get?.is_requesting,
            status.value?.cache?.get?.is_requesting_now,
            status.value?.cache?.get?.is_requested,
            status.value?.cache?.get?.is_blank,
            status.value?.cache?.get?.is_success,
            status.value?.cache?.get?.is_success_now,
            status.value?.cache?.get?.is_error,
            status.value?.cache?.get?.error,
            status.value?.cache?.save?.is_requesting,
            status.value?.cache?.save?.is_requesting_now,
            status.value?.cache?.save?.is_requested,
            status.value?.cache?.save?.is_success,
            status.value?.cache?.save?.is_success_now,
            status.value?.cache?.save?.is_error,
            status.value?.cache?.save?.error
        ],
        () => {
            if (typeof document === 'undefined') return;
            document.dispatchEvent(new CustomEvent('status-updated', { detail: status.value, bubbles: true }));
        }
    );

    const is_done = computed(() => status.value.server.get.is_success);
    const is_done_to_show = computed(() => (status.value.server.get.is_success && !status.value.server.get.is_blank) || status.value.cache.get.is_success);

    watch(() => [status.value.server.get.is_requesting, status.value.server.get.is_success, trigger_server_get.value], ([isReq, isSuccess], _, onCleanup) => {
        if (timer_server_get) {
            clearTimeout(timer_server_get);
            timer_server_get = null;
        }
        status.value.server.get.is_requesting_now = isReq;
        status.value.server.get.is_success_now = isSuccess;
        if (isReq || isSuccess) {
            timer_server_get = setTimeout(() => {
                status.value.server.get.is_requesting_now = false;
                status.value.server.get.is_success_now = false;
                timer_server_get = null;
            }, 500);
            onCleanup(() => {
                if (timer_server_get) {
                    clearTimeout(timer_server_get);
                    timer_server_get = null;
                }
            });
        }
    });

    watch(() => [status.value.server.save.is_requesting, status.value.server.save.is_success, trigger_server_save.value], ([isReq, isSuccess], _, onCleanup) => {
        if (timer_server_save) {
            clearTimeout(timer_server_save);
            timer_server_save = null;
        }
        status.value.server.save.is_requesting_now = isReq;
        status.value.server.save.is_success_now = isSuccess;
        if (isReq || isSuccess) {
            timer_server_save = setTimeout(() => {
                status.value.server.save.is_requesting_now = false;
                status.value.server.save.is_success_now = false;
                timer_server_save = null;
            }, 500);
            onCleanup(() => {
                if (timer_server_save) {
                    clearTimeout(timer_server_save);
                    timer_server_save = null;
                }
            });
        }
    });

    watch(() => [status.value.cache.get.is_requesting, status.value.cache.get.is_success, trigger_cache_get.value], ([isReq, isSuccess], _, onCleanup) => {
        if (timer_cache_get) {
            clearTimeout(timer_cache_get);
            timer_cache_get = null;
        }
        status.value.cache.get.is_requesting_now = isReq;
        status.value.cache.get.is_success_now = isSuccess;
        if (isReq || isSuccess) {
            timer_cache_get = setTimeout(() => {
                status.value.cache.get.is_requesting_now = false;
                status.value.cache.get.is_success_now = false;
                timer_cache_get = null;
            }, 500);
            onCleanup(() => {
                if (timer_cache_get) {
                    clearTimeout(timer_cache_get);
                    timer_cache_get = null;
                }
            });
        }
    });

    watch(() => [status.value.cache.save.is_requesting, status.value.cache.save.is_success, trigger_cache_save.value], ([isReq, isSuccess], _, onCleanup) => {
        if (timer_cache_save) {
            clearTimeout(timer_cache_save);
            timer_cache_save = null;
        }
        status.value.cache.save.is_requesting_now = isReq;
        status.value.cache.save.is_success_now = isSuccess;
        if (isReq || isSuccess) {
            timer_cache_save = setTimeout(() => {
                status.value.cache.save.is_requesting_now = false;
                status.value.cache.save.is_success_now = false;
                timer_cache_save = null;
            }, 500);
            onCleanup(() => {
                if (timer_cache_save) {
                    clearTimeout(timer_cache_save);
                    timer_cache_save = null;
                }
            });
        }
    });

    watchValid(() => store.loading_options?.message, (message) => {
        setLoadingMessage(message as string);
    });

    function setLoadingMessage(message: string) {
        const k: string = getKey();
        const target = store.loading_options?.target ?? store?.loading_target ?? 'body';
        loading.update?.({ target, key: k, message });
    }

    function setLoading(_server?: string) {
        if (anyIsFalseIn(store, ['enabled', 'options.enabled', 'loading_options.enabled'])) return;
        if (store.enabled === false) return;

        const k: string = getKey();
        if (k && cfg.isAppStarted() && !is_done_to_show.value) {
            const options = { ...(store.loading_options ?? { target: 'body' }) };
            if (!options.message) return;
            options.key ??= k;
            options.target ??= 'body';
            options.message ??= 'Carregando informações... ';
            loading.start?.(options);
        }
    }

    function stopLoading(k?: string | null, _server?: string) {
        const targetKey: string = k ?? getKey();
        loading.stop?.(targetKey);
    }

    let cancel_timer: ReturnType<typeof setTimeout> | null = null;
    const is_cancelling = ref(false);
    const cancelLoad = (retryInSeconds: number | boolean | null = null) => {
        if (cancel_timer) {
            clearTimeout(cancel_timer);
            cancel_timer = null;
        }
        is_cancelling.value = false;

        if (signal_get_request.value) {
            signal_get_request.value.abort();
            signal_get_request.value = null;
        }
        if (retryInSeconds === true || retryInSeconds === 0) retryInSeconds = 5;
        const seconds = Number(retryInSeconds);
        if (seconds > 0) {
            is_cancelling.value = true;
            cancel_timer = setTimeout(() => {
                cancel_timer = null;
                is_cancelling.value = false;
                if (!isDisposed) void loadInServer();
            }, seconds * 1000);
        }
    };

    const loadInServer = async (): Promise<void> => {
        cfg.onActivity();
        if (isDisposed) return;
        if (is_cancelling.value) return;
        if (store.enabled === false || store.options?.enabled === false) return;

        const route_name: string | null = getRouteName();
        if (!route_name) return;

        if (signal_get_request.value) {
            const inDeduplication = getInDeduplication();
            if (inDeduplication === 'last' || inDeduplication === 'cancel' || inDeduplication === 'this') signal_get_request.value.abort();
            if (inDeduplication === 'ignore' || inDeduplication === 'first') return;
        }

        trigger_server_get.value++;
        status.value.server.get.is_requesting = true;
        status.value.server.get.is_requested = false;
        status.value.server.get.is_success = false;
        status.value.server.get.is_error = false;
        status.value.server.get.error = null;
        const requestController = new AbortController();
        signal_get_request.value = requestController;

        const identity = captureReadIdentity();
        const requestSequence = ++serverRequestSequence;
        activeServerRequestSequence = requestSequence;

        const isCurrentRequest = () =>
            !isDisposed
            && requestSequence === activeServerRequestSequence
            && !requestController.signal.aborted
            && isReadIdentityCurrent(identity);

        if (!status.value.cache.get.is_success || status.value.cache.get.is_blank) setLoading('server');

        const finishCurrentRequest = () => {
            if (requestSequence === activeServerRequestSequence) {
                status.value.server.get.is_requesting = false;
                status.value.server.get.is_requested = true;
                stopLoading(identity.key, 'server');
            }
            if (signal_get_request.value === requestController) signal_get_request.value = null;
        };

        let axios: any;
        let route_url: string;
        let requestMeta: any;
        const data_get = getRouteData();
        try {
            route_url = cfg.resolveRoute(route_name, data_get);
            requestMeta = typeof store.createRequestMeta === 'function'
                ? store.createRequestMeta()
                : { route: route_name, data: cloneDeep(toRaw(data_get)), key: identity.key };
            axios = await getAxios();
        } catch (error: any) {
            if (isCurrentRequest()) {
                status.value.server.get.is_error = true;
                status.value.server.get.error = error;
            }
            finishCurrentRequest();
            return;
        }

        if (!isCurrentRequest()) {
            finishCurrentRequest();
            return;
        }

        try {
            const response = await axios.get(route_url, { timeout: cfg.requestTimeout, signal: requestController.signal });
            if (!isCurrentRequest()) return;

            pauseSave();
            try {
                if (typeof store.onServerData === 'function') {
                    store.onServerData(response.data, requestMeta);
                } else {
                    store.data = store.is_shallow || store.isShallow ? cloneDeep(response.data) : response.data;
                }
            } finally {
                resumeSave();
            }

            status.value.server.get.is_success = true;
            status.value.server.get.is_error = false;
            status.value.server.get.error = null;

            await saveInCache().catch((error: any) => console.error('[max-pinia] ERROR IN SAVE CACHE: ' + error.name, error));

            if (isCurrentRequest() && store.afterLoad) {
                store.afterLoad(requestMeta);
            }
        } catch (error: any) {
            if (isCurrentRequest() && error.name !== 'CanceledError') {
                console.error('[max-pinia] LOAD SERVER - Route: ' + route_name + ' - Error: ' + error.name, { data_load: data_get, error });
                status.value.server.get.is_success = false;
                status.value.server.get.is_error = true;
                status.value.server.get.error = error;
            }
        } finally {
            finishCurrentRequest();
        }
    };

    const reload = async (): Promise<void> => {
        const identity = captureReadIdentity();
        await loadInServer();
        if (!isDisposed && isReadIdentityCurrent(identity) && store.afterReload) {
            store.afterReload();
        }
    };

    const loadInCache = () => {
        cfg.onActivity();
        if (isDisposed) return;
        if (store.enabled === false || store.options?.enabled === false) return;

        const identity = captureReadIdentity();
        const requestSequence = ++cacheRequestSequence;
        activeCacheRequestSequence = requestSequence;
        const isCurrentRequest = () => !isDisposed && requestSequence === activeCacheRequestSequence && isReadIdentityCurrent(identity);

        trigger_cache_get.value++;
        status.value.cache.get.is_requesting = true;
        status.value.cache.get.is_requested = false;
        status.value.cache.get.is_success = false;
        status.value.cache.get.is_error = false;
        status.value.cache.get.error = null;
        setLoading('loading - cache');
        storage.getItem(identity.key)
            .then((data_cache: any) => {
                if (!isCurrentRequest()) return;
                status.value.cache.get.is_requested = true;
                status.value.cache.get.is_success = true;
                if (data_cache?.data) try {
                    status.value.cache.get.is_blank = false;
                    pauseSave();
                    if (store.isShallow || store.options?.isShallow) {
                        store.data = null;
                        store.data = data_cache.data;
                    } else store.data = data_cache.data;

                    resumeSave();
                    const include_in_cache = getIncludes() ?? [];
                    for (const k of include_in_cache) if (store[k] !== undefined) store[k] = data_cache[k];

                    if (checkOnlyCache()) return;
                } catch (cacheError: any) {
                    console.error('[max-pinia] CACHE CORRUPTED - Key: ' + identity.key + ' - Error: ' + cacheError.name, cacheError);
                    storage.removeItem(identity.key).catch(() => {});
                    resumeSave();
                }
                else status.value.cache.get.is_blank = true;

                loadInServer()
                    .then()
                    .catch((error: any) => console.error('[max-pinia] IN LOAD SERVER AFTER CACHE - Route: ' + getRouteName() + ' - Error: ' + error.name, { get_data: getRouteData(), error }));
            })
            .catch((error: any) => {
                if (!isCurrentRequest()) return;
                console.error('[max-pinia] LOAD CACHE ERROR: ' + error.name, error);
                status.value.cache.get.is_success = false;
                status.value.cache.get.is_error = true;
                status.value.cache.get.error = error;

                // C: Cache indisponível tenta GET no backend uma única vez
                loadInServer()
                    .then()
                    .catch((err: any) => console.error('[max-pinia] IN LOAD SERVER AFTER CACHE ERROR - Route: ' + getRouteName() + ' - Error: ' + err.name, { get_data: getRouteData(), error: err }));
            })
            .finally(() => {
                if (!isCurrentRequest()) return;
                status.value.cache.get.is_requested = true;
                status.value.cache.get.is_requesting = false;
                stopLoading(identity.key, 'cache');
            });
    };

    const includeInCacheValues: Ref = computed(() => {
        const data_include: any = {};
        const include_in_cache = getIncludes() ?? [];
        for (const k of include_in_cache) if (store[k] !== undefined) data_include[k] = store[k];
        return data_include;
    });

    watch(includeInCacheValues, () => saveInCache(), { deep: true });

    const saveInCache = async (data_save: any = null): Promise<void> => {
        cfg.onActivity();
        if (isDisposed) return;
        if (store.enabled === false || store.options?.enabled === false) {
            setDefaultData();
            return;
        }
        if (size(store.data) === 0) return;

        trigger_cache_save.value++;
        const saveSequence = ++cacheSaveSequence;
        activeCacheSaveSequence = saveSequence;
        const identity = captureReadIdentity();

        const isCurrentSave = () =>
            !isDisposed
            && saveSequence === activeCacheSaveSequence
            && identity.generation === identityGeneration;

        const data: any = data_save ? data_save : { data: store.data ?? {}, ...includeInCacheValues.value };
        // cloneDeep (em vez de JSON round-trip) preserva Date, trata referências
        // circulares e desembrulha os proxies reativos do Vue para o structured-clone do localforage.
        const cleanData = cloneDeep(toRaw(data));
        status.value.cache.save.is_requesting = true;
        status.value.cache.save.is_requested = true;
        status.value.cache.save.is_success = false;
        status.value.cache.save.is_error = false;
        status.value.cache.save.error = null;

        try {
            await storage.setItem(getKey(), cleanData);
            if (isCurrentSave()) {
                status.value.cache.save.is_requested = true;
                status.value.cache.save.is_success = true;
            }
        } catch (error: any) {
            console.error('[max-pinia] SAVE CACHE ERROR: ' + error.name, error);
            if (isCurrentSave()) {
                status.value.cache.save.is_success = false;
                status.value.cache.save.is_error = true;
                status.value.cache.save.error = error;
            }
        } finally {
            if (saveSequence === activeCacheSaveSequence && !isDisposed) {
                status.value.cache.save.is_requested = true;
                status.value.cache.save.is_requesting = false;
            }
        }
    };

    const postInDeduplication = () => store?.in_deduplication ?? store?.options?.in_deduplication ?? store?.in_save_deduplication ?? store?.options?.in_save_deduplication ?? store?.in_post_deduplication ?? store?.options?.in_post_deduplication ?? 'last';
    const postRouteName = (): string | null => getIn(store, ['options.save', 'options.post', 'options.route_post', 'options.post_route', 'options.save_route', 'options.route_save', 'save', 'post', 'route_post', 'post_route', 'save_route', 'route_save']);
    const getPostData = () => {
        let source = store.getSaveData ?? getIn(store, ['post_data', 'data_post', 'options.post.data', 'options.post_data', 'options.data_post', 'saveData', 'data_save', 'options.save.data', 'options.saveData', 'options.data_save']);
        if (typeof source === 'function') source = source();
        if (!source) return null;
        const data_return: Record<string, any> = {};
        for (const k in source) data_return[k] = toValue(source[k]);
        return data_return;
    };
    const signal_post_request: Ref = ref(null);
    const saveInServer = async (): Promise<void> => {
        cfg.onActivity();
        if (isDisposed) return;
        if (store.enabled === false || store.options?.enabled === false) return;
        const route_name: string | null = postRouteName();
        if (!route_name) return;
        const data_send = cloneDeep(toRaw(getPostData() ?? store.data) ?? {});
        if (size(data_send) === 0) return;

        if (signal_post_request.value) {
            const inDeduplication = postInDeduplication();
            if (inDeduplication === 'last' || inDeduplication === 'cancel' || inDeduplication === 'this') signal_post_request.value.abort();
            if (inDeduplication === 'ignore' || inDeduplication === 'first') return;
        }

        trigger_server_save.value++;
        status.value.server.save.is_requesting = true;
        status.value.server.save.is_requested = false;
        status.value.server.save.is_success = false;
        status.value.server.save.is_error = false;
        status.value.server.save.error = null;

        const requestController = new AbortController();
        signal_post_request.value = requestController;

        const identity = capturePostIdentity();
        const requestSequence = ++postRequestSequence;
        activePostRequestSequence = requestSequence;

        const isCurrentPost = () =>
            !isDisposed
            && requestSequence === activePostRequestSequence
            && !requestController.signal.aborted
            && isPostIdentityCurrent(identity);

        const finishCurrentPost = () => {
            if (requestSequence === activePostRequestSequence) {
                status.value.server.save.is_requesting = false;
                status.value.server.save.is_requested = true;
            }
            if (signal_post_request.value === requestController) {
                signal_post_request.value = null;
            }
        };

        let axios: any;
        let resolvedRouteUrl: string;
        try {
            axios = await getAxios();
            resolvedRouteUrl = cfg.resolveRoute(route_name);
        } catch (error: any) {
            if (isCurrentPost()) {
                status.value.server.save.is_error = true;
                status.value.server.save.error = error;
            }
            finishCurrentPost();
            return;
        }

        if (!isCurrentPost()) {
            finishCurrentPost();
            return;
        }

        const sessionToken = cfg.getSessionToken();
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            ...(sessionToken ? { 'X-CSRF-TOKEN': sessionToken } : {})
        };
        const axiosConfig = {
            timeout: cfg.requestTimeout,
            signal: requestController.signal,
            onDownloadProgress: (progressEvent: any) => {
                if (isCurrentPost()) {
                    progress_loading.value = progressEvent.loaded / progressEvent.total;
                }
            },
            headers,
            withCredentials: true
        };

        if (store.removeToSave || store.remove_to_save) {
            const remove = store.removeToSave ?? store.remove_to_save;
            for (const k in remove) unset(data_send, remove[k]);
        }

        try {
            const response = await axios.post(resolvedRouteUrl, data_send, axiosConfig);
            if (!isCurrentPost()) return;

            if (store.save_return) {
                pauseSave();
                try {
                    if (typeof store.save_return === 'string' && store.data[store.save_return] !== response.data[store.save_return]) {
                        store.data = response.data;
                    } else if (store.save_return === true) {
                        store.data = response.data.original ?? response.data ?? {};
                    }
                } finally {
                    resumeSave();
                }
            }

            status.value.server.save.is_success = true;
            status.value.server.save.is_error = false;
            status.value.server.save.error = null;

            await saveInCache().catch((error: any) => console.error('[max-pinia] SAVE IN CACHE ERROR: ' + error.name, error));

            if (isCurrentPost() && store.reload_after_save) {
                void loadInServer();
            }
            if (store.reload_after_save_default) {
                store.reload_after_save = store.reload_after_save_default;
            }
        } catch (error: any) {
            if (isCurrentPost() && error.name !== 'CanceledError') {
                console.error('[max-pinia] SAVE IN SERVER ERROR. Route: ' + route_name + ' - Error:' + error.name, error);
                status.value.server.save.is_success = false;
                status.value.server.save.is_error = true;
                status.value.server.save.error = error;
            }
        } finally {
            finishCurrentPost();
        }
    };

    let pauseDepth = 0;
    const is_save_in_pause: Ref<boolean> = ref(true);

    const pauseSave = () => {
        pauseDepth++;
        is_save_in_pause.value = true;
    };

    const resumeSave = () => {
        nextTick(() => {
            pauseDepth = Math.max(0, pauseDepth - 1);
            if (pauseDepth === 0) {
                is_save_in_pause.value = false;
            }
        });
    };

    interface AutosaveToken {
        generation: number;
        key: string;
        routeName: string | null;
    }
    let scheduledAutosaveToken: AutosaveToken | null = null;

    const countChanges: Ref = ref(0);
    watch(() => cloneDeep(store.data), (new_val, old_val) => {
        if (isDisposed) return;
        if (is_save_in_pause.value || isBlank(old_val) || isBlank(new_val)) return;
        const isBlocked = store.block_save ?? store.no_save ?? store.noSave ?? store.blockSave ?? store.isList ?? store.is_list ?? false;
        if (isBlocked || isEqual(new_val, old_val)) return;

        scheduledAutosaveToken = {
            generation: identityGeneration,
            key: getKey(),
            routeName: postRouteName()
        };
        countChanges.value += 1;
    });

    watchDebounced(() => countChanges.value, () => {
        if (isDisposed) return;
        if (!scheduledAutosaveToken) return;

        const token = scheduledAutosaveToken;
        scheduledAutosaveToken = null;

        if (token.generation !== identityGeneration || token.key !== getKey() || token.routeName !== postRouteName()) {
            return;
        }

        if (is_save_in_pause.value) return;
        const isBlocked = store.block_save ?? store.no_save ?? store.noSave ?? store.blockSave ?? store.isList ?? store.is_list ?? false;
        if (isBlocked) return;
        if (store.enabled === false || store.options?.enabled === false) return;

        void saveInServer();
    }, { debounce: 300 });

    watch(key, (new_key, old_key) => {
        stopLoading(old_key, 'auto');
        stopLoading(new_key, 'auto');
    });

    watch([() => getKey(), () => store.enabled, () => store.options?.enabled], () => {
        identityGeneration++;
        activeServerRequestSequence = ++serverRequestSequence;
        activeCacheRequestSequence = ++cacheRequestSequence;
        activePostRequestSequence = ++postRequestSequence;
        activeCacheSaveSequence = ++cacheSaveSequence;
        scheduledAutosaveToken = null;
        idx.value = store.id ?? store.options?.id;
        pauseSave();
        setDefaultData();
        resumeSave();
        clearStatusTimers();
        status.reset();
        if (store.enabled === false || store.options?.enabled === false) {
            if (cancel_timer) {
                clearTimeout(cancel_timer);
                cancel_timer = null;
                is_cancelling.value = false;
            }
            if (signal_get_request.value) {
                signal_get_request.value.abort();
                signal_get_request.value = null;
            }
            if (signal_post_request.value) {
                signal_post_request.value.abort();
                signal_post_request.value = null;
            }
            return;
        }
        loadInCache();
    }, { immediate: true, flush: 'sync' });

    const disposePlugin = () => {
        if (isDisposed) return;
        isDisposed = true;
        identityGeneration++;
        activeServerRequestSequence = ++serverRequestSequence;
        activeCacheRequestSequence = ++cacheRequestSequence;
        activePostRequestSequence = ++postRequestSequence;
        activeCacheSaveSequence = ++cacheSaveSequence;
        scheduledAutosaveToken = null;

        if (cancel_timer) {
            clearTimeout(cancel_timer);
            cancel_timer = null;
            is_cancelling.value = false;
        }

        if (signal_get_request.value) {
            signal_get_request.value.abort();
            signal_get_request.value = null;
        }
        if (signal_post_request.value) {
            signal_post_request.value.abort();
            signal_post_request.value = null;
        }

        stopLoading(getKey(), 'dispose');
        clearStatusTimers();
    };

    if (store.$dispose) {
        const originalDispose = store.$dispose.bind(store);
        store.$dispose = () => {
            disposePlugin();
            originalDispose();
        };
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            disposePlugin();
        });
    }

    const clearAll = async () => {
        try {
            const allKeys = typeof storage.keys === 'function' ? (await storage.keys()) || [] : [];
            const prefix = `${store.$id}.`;
            const storeKeys = allKeys.filter((k: string) => k === store.$id || k.startsWith(prefix));
            await Promise.all(storeKeys.map((k: string) => storage.removeItem(k)));
        } catch (error: any) {
            console.error('[max-pinia] CLEAR ALL ERROR: ' + error.name, error);
        }
    };

    return { idx, countChanges, key, setLoadingMessage, cancelLoad, is_save_in_pause, pauseSave, resumeSave, reload, clearAll, default_value, setDefaultData, status, is_done, saveInServer, saveInCache, is_done_to_show } as any;
}

/** Hook utilitário: observa o status agregado emitido por qualquer store cacheada. */
export function useAsyncStatus(): Ref<Status | null> {
    const asyncStatus = ref<Status | null>(null);
    if (typeof document !== 'undefined') {
        const handler = (event: Event) => {
            asyncStatus.value = (event as CustomEvent<Status>).detail;
        };
        document.addEventListener('status-updated', handler);
        if (getCurrentScope()) {
            onScopeDispose(() => {
                document.removeEventListener('status-updated', handler);
            });
        }
    }
    return asyncStatus;
}
