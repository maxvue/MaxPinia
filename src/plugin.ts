import { ref, computed, watch, nextTick, toValue, toRaw, getCurrentScope, onScopeDispose, type Ref } from 'vue';
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
    return str ? `${url}?${str}` : url;
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

    const cache_name: Ref = store.cache_name ?? ref(cfg.cacheName);
    localforage.config({ name: cache_name.value, storeName: cfg.storeName });

    const loading = cfg.loading;
    const default_value = ref(cloneDeep(store.data));

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

    const setDefaultData = () => store.data = store.default_value ?? store.default_data ?? store.defaultData ?? store.dataDefault ?? store.data_default ?? store.default ?? default_value.value ?? {};

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
    status.reset = () => {
        clearStatusTimers();
        originalStatusReset();
    };

    const trigger_server_get = ref(0);
    const trigger_server_save = ref(0);
    const trigger_cache_get = ref(0);
    const trigger_cache_save = ref(0);

    watch(status, () => {
        if (typeof document === 'undefined') return;
        document.dispatchEvent(new CustomEvent('status-updated', { detail: status.value, bubbles: true }));
    });

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

        if (signal_get_request.value) signal_get_request.value.abort();
        if (retryInSeconds === true || retryInSeconds === 0) retryInSeconds = 5;
        const seconds = Number(retryInSeconds);
        if (seconds > 0) {
            is_cancelling.value = true;
            cancel_timer = setTimeout(() => {
                cancel_timer = null;
                is_cancelling.value = false;
                loadInServer().then();
            }, seconds * 1000);
        }
    };

    const loadInServer = async () => {
        cfg.onActivity();
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
        signal_get_request.value = new AbortController();

        const data_get = getRouteData();
        const route_url = cfg.resolveRoute(route_name, data_get);

        if (!status.value.cache.get.is_success || status.value.cache.get.is_blank) setLoading('server');

        const axios = await getAxios();
        axios.get(route_url, { timeout: cfg.requestTimeout, signal: signal_get_request.value.signal })
            .then((response: any) => {
                pauseSave();
                store.data = response.data;
                if (store.is_shallow || store.isShallow) {
                    const data_server = cloneDeep(response.data);
                    store.data = data_server;
                    saveInCache(data_server);
                }
                resumeSave();
                status.value.server.get.is_success = true;
                status.value.server.get.is_error = false;
                saveInCache()
                    .then()
                    .catch((error: any) => console.error('[max-pinia] ERROR IN SAVE CACHE: ' + error.name, error));

                if (store.afterLoad) store.afterLoad();
            })
            .catch((error: any) => {
                if (error.name !== 'CanceledError') {
                    console.error('[max-pinia] LOAD SERVER - Route: ' + route_name + ' - Error: ' + error.name, { data_load: data_get, error });
                    status.value.server.get.is_success = false;
                    status.value.server.get.is_error = true;
                    status.value.server.get.error = error;
                }
            })
            .finally(() => {
                status.value.server.get.is_requesting = false;
                status.value.server.get.is_requested = true;
                stopLoading(null, 'server');
            });
    };

    const reload = async () => {
        await loadInServer();
        if (store.afterReload) store.afterReload();
    };

    const loadInCache = () => {
        cfg.onActivity();
        if (store.enabled === false || store.options?.enabled === false) return;

        trigger_cache_get.value++;
        status.value.cache.get.is_requesting = true;
        status.value.cache.get.is_requested = false;
        status.value.cache.get.is_success = false;
        setLoading('loading - cache');
        localforage.getItem(getKey())
            .then((data_cache: any) => {
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
                    console.error('[max-pinia] CACHE CORRUPTED - Key: ' + getKey() + ' - Error: ' + cacheError.name, cacheError);
                    localforage.removeItem(getKey()).catch(() => {});
                    resumeSave();
                }
                else status.value.cache.get.is_blank = true;

                loadInServer()
                    .then()
                    .catch((error: any) => console.error('[max-pinia] IN LOAD SERVER AFTER CACHE - Route: ' + getRouteName() + ' - Error: ' + error.name, { get_data: getRouteData(), error }));
            })
            .catch((error: any) => {
                console.error('[max-pinia] LOAD CACHE ERROR: ' + error.name, error);
                status.value.cache.get.is_success = false;
                status.value.cache.get.is_error = true;
                status.value.cache.get.error = error;
            })
            .finally(() => {
                status.value.cache.get.is_requested = true;
                status.value.cache.get.is_requesting = false;
                stopLoading(null, 'cache');
            });
    };

    const includeInCacheValues: Ref = computed(() => {
        const data_include: any = {};
        const include_in_cache = getIncludes() ?? [];
        for (const k of include_in_cache) if (store[k] !== undefined) data_include[k] = store[k];
        return data_include;
    });

    watch(includeInCacheValues, () => saveInCache(), { deep: true });

    const saveInCache = async (data_save: any = null) => {
        cfg.onActivity();
        if (store.enabled === false || store.options?.enabled === false) {
            setDefaultData();
            return;
        }
        if (size(store.data) === 0) return;

        trigger_cache_save.value++;
        const data: any = data_save ? data_save : { data: store.data ?? {}, ...includeInCacheValues.value };
        // cloneDeep (em vez de JSON round-trip) preserva Date, trata referências
        // circulares e desembrulha os proxies reativos do Vue para o structured-clone do localforage.
        const cleanData = cloneDeep(toRaw(data));
        status.value.cache.save.is_requesting = true;
        status.value.cache.save.is_requested = true;
        localforage
            .setItem(getKey(), cleanData)
            .then(() => {
                status.value.cache.save.is_requested = true;
                status.value.cache.save.is_success = true;
            })
            .catch((error: any) => {
                console.error('[max-pinia] SAVE CACHE ERROR: ' + error.name, error);
                status.value.cache.save.is_success = false;
                status.value.cache.save.is_error = true;
                status.value.cache.save.error = error;
            })
            .finally(() => {
                status.value.cache.save.is_requested = true;
                status.value.cache.save.is_requesting = false;
            });
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
    const saveInServer = async () => {
        cfg.onActivity();
        const route_name: string | null = postRouteName();
        const data_send = getPostData() ?? { ...store.data };

        if (!route_name) return;
        if (store.enabled === false || store.options?.enabled === false) return;
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

        signal_post_request.value = new AbortController();
        const sessionToken = cfg.getSessionToken();
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            ...(sessionToken ? { 'X-CSRF-TOKEN': sessionToken } : {})
        };
        const axiosConfig = {
            timeout: cfg.requestTimeout,
            signal: signal_post_request.value.signal,
            onDownloadProgress: (progressEvent: any) => {
                progress_loading.value = progressEvent.loaded / progressEvent.total;
            },
            headers,
            withCredentials: true
        };

        if (store.removeToSave || store.remove_to_save) {
            const remove = store.removeToSave ?? store.remove_to_save;
            for (const k in remove) unset(data_send, remove[k]);
        }

        const axios = await getAxios();
        axios.post(cfg.resolveRoute(route_name), data_send, axiosConfig)
            .then((response: any) => {
                if (store.save_return) {
                    pauseSave();
                    if (typeof store.save_return === 'string' && store.data[store.save_return] !== response.data[store.save_return]) store.data = response.data;
                    else if (store.save_return === true) store.data = response.data.original ?? response.data ?? {};
                    resumeSave();
                }

                status.value.server.save.is_success = true;
                status.value.server.save.is_error = false;
                saveInCache()
                    .then()
                    .catch((error: any) => console.error('[max-pinia] SAVE IN CACHE ERROR: ' + error.name, error));
                if (store.reload_after_save) loadInServer();
                if (store.reload_after_save_default) store.reload_after_save = store.reload_after_save_default;
            })
            .catch((error: any) => {
                console.error('[max-pinia] SAVE IN SERVER ERROR. Route: ' + route_name + ' - Error:' + error.name, error);
                status.value.server.save.is_success = false;
                status.value.server.save.is_error = true;
                status.value.server.save.error = error;
            })
            .finally(() => {
                status.value.server.save.is_requesting = false;
                status.value.server.save.is_requested = true;
            });
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

    const countChanges: Ref = ref(0);
    watch(() => cloneDeep(store.data), (new_val, old_val) => {
        if (is_save_in_pause.value || isBlank(old_val) || isBlank(new_val)) return;
        const isBlocked = store.block_save ?? store.no_save ?? store.noSave ?? store.blockSave ?? store.isList ?? store.is_list ?? false;
        if (isBlocked || isEqual(new_val, old_val)) return;
        countChanges.value += 1;
    });

    watchDebounced(() => countChanges.value, () => saveInServer(), { debounce: 300 });

    watch(key, (new_key, old_key) => {
        stopLoading(old_key, 'auto');
        stopLoading(new_key, 'auto');
    });

    watch(() => [store.id, store.enabled, store.options?.enabled], () => {
        idx.value = store.id;
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
            if (signal_get_request.value) signal_get_request.value.abort();
            return;
        }
        loadInCache();
    }, { immediate: true });

    if (store.$dispose) {
        const originalDispose = store.$dispose.bind(store);
        store.$dispose = () => {
            clearStatusTimers();
            originalDispose();
        };
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            clearStatusTimers();
        });
    }

    const clearAll = async () => await localforage.clear();

    return { idx, countChanges, key, setLoadingMessage, cancelLoad, is_save_in_pause, pauseSave, resumeSave, reload, clearAll, default_value, status, is_done, saveInServer, saveInCache, is_done_to_show } as any;
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
