import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, ref, computed } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { createMaxPinia } from '../src';

vi.mock('localforage', () => ({
    default: {
        config: vi.fn(),
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(null),
        removeItem: vi.fn().mockResolvedValue(null),
        clear: vi.fn().mockResolvedValue(null)
    }
}));

let storeCounter = 0;

function setupStore(config: Parameters<typeof createMaxPinia>[0], storeSetup: () => any) {
    storeCounter++;
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore(`test.dedup.${storeCounter}`, storeSetup)();
}

describe('Estratégias de Deduplicação de Requisições', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('Deduplicação em POST (saveInServer)', () => {
        it('Caso 1: Estratégias "last" / "cancel" / "this" abortam a requisição anterior em voo', async () => {
            const strategies = ['last', 'cancel', 'this'] as const;

            for (const strategy of strategies) {
                let resolvePost1!: (val: any) => void;
                const promise1 = new Promise((resolve) => { resolvePost1 = resolve; });
                let resolvePost2!: (val: any) => void;
                const promise2 = new Promise((resolve) => { resolvePost2 = resolve; });

                const axiosPost = vi.fn().mockImplementation(() => {
                    if (axiosPost.mock.calls.length === 1) return promise1;
                    return promise2;
                });

                const store = setupStore(
                    { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
                    () => {
                        const isCached = ref(true);
                        const in_deduplication = ref(strategy);
                        const data = ref<Record<string, any>>({ count: 1 });
                        const options = computed(() => ({ save: '/api/save' }));
                        return { isCached, in_deduplication, data, options };
                    }
                );

                await vi.advanceTimersByTimeAsync(10);

                // 1ª chamada
                store.saveInServer();
                await vi.waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
                const signal1: AbortSignal = axiosPost.mock.calls[0][2].signal;
                expect(signal1.aborted).toBe(false);

                // 2ª chamada concorrente (enquanto a 1ª está in-flight)
                store.data.count = 2;
                store.saveInServer();
                await vi.waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(2));

                const signal2: AbortSignal = axiosPost.mock.calls[1][2].signal;
                expect(signal1.aborted).toBe(true);
                expect(signal2.aborted).toBe(false);

                // Finaliza as promises
                resolvePost1({ data: { saved: 1 } });
                resolvePost2({ data: { saved: 2 } });
                await vi.waitFor(() => expect(store.status.server.save.is_requested).toBe(true));
            }
        });

        it('Caso 1.1: Suporte a variações de propriedades de deduplicação POST (in_save_deduplication, in_post_deduplication, options.in_save_deduplication)', async () => {
            const configs = [
                { prop: 'in_save_deduplication', val: 'cancel' },
                { prop: 'in_post_deduplication', val: 'last' },
                { optProp: 'in_save_deduplication', val: 'this' },
                { optProp: 'in_post_deduplication', val: 'cancel' }
            ];

            for (const cfg of configs) {
                const promise1 = new Promise(() => {});
                const promise2 = new Promise((resolve) => resolve({ data: {} }));

                const axiosPost = vi.fn().mockImplementation(() => {
                    if (axiosPost.mock.calls.length === 1) return promise1;
                    return promise2;
                });

                const store = setupStore(
                    { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
                    () => {
                        const isCached = ref(true);
                        const data = ref<Record<string, any>>({ title: 'Item' });
                        const options = computed(() => ({
                            save: '/api/save',
                            ...(cfg.optProp ? { [cfg.optProp]: cfg.val } : {})
                        }));
                        const rootProps = cfg.prop ? { [cfg.prop]: ref(cfg.val) } : {};
                        return { isCached, data, options, ...rootProps };
                    }
                );

                await vi.advanceTimersByTimeAsync(10);

                store.saveInServer();
                await vi.waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
                const signal1: AbortSignal = axiosPost.mock.calls[0][2].signal;
                expect(signal1.aborted).toBe(false);

                store.saveInServer();
                await vi.waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(2));
                expect(signal1.aborted).toBe(true);
            }
        });

        it('Caso 2: Estratégias "ignore" e "first" descartam novas requisições POST enquanto houver uma em voo', async () => {
            const ignoreStrategies = ['ignore', 'first'] as const;

            for (const strategy of ignoreStrategies) {
                let resolvePost!: (val: any) => void;
                const pendingPromise = new Promise((resolve) => { resolvePost = resolve; });

                const axiosPost = vi.fn().mockReturnValue(pendingPromise);

                const store = setupStore(
                    { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
                    () => {
                        const isCached = ref(true);
                        const in_deduplication = ref(strategy);
                        const data = ref<Record<string, any>>({ count: 1 });
                        const options = computed(() => ({ save: '/api/save' }));
                        return { isCached, in_deduplication, data, options };
                    }
                );

                await vi.advanceTimersByTimeAsync(10);

                // 1ª chamada inicia requisição
                store.saveInServer();
                await vi.waitFor(() => expect(axiosPost).toHaveBeenCalledTimes(1));
                const signal1: AbortSignal = axiosPost.mock.calls[0][2].signal;
                expect(signal1.aborted).toBe(false);

                // 2ª chamada e 3ª chamada enquanto a 1ª está em voo
                store.saveInServer();
                store.saveInServer();

                // Nenhuma nova chamada efetuada e a primeira NÃO foi abortada
                expect(axiosPost).toHaveBeenCalledTimes(1);
                expect(signal1.aborted).toBe(false);

                // Conclui a primeira requisição
                resolvePost({ data: { success: true } });
                await vi.waitFor(() => expect(store.status.server.save.is_requested).toBe(true));
            }
        });
    });

    describe('Deduplicação em GET (loadInServer)', () => {
        it('Caso 3: Estratégias "last" / "cancel" / "this" abortam a requisição GET anterior em voo', async () => {
            const strategies = ['last', 'cancel', 'this'] as const;

            for (const strategy of strategies) {
                let resolveGet1!: (val: any) => void;
                const promise1 = new Promise((resolve) => { resolveGet1 = resolve; });
                let resolveGet2!: (val: any) => void;
                const promise2 = new Promise((resolve) => { resolveGet2 = resolve; });

                const axiosGet = vi.fn().mockImplementation(() => {
                    if (axiosGet.mock.calls.length === 1) return promise1;
                    return promise2;
                });

                const store = setupStore(
                    { axios: { get: axiosGet, post: vi.fn() } as any },
                    () => {
                        const isCached = ref(true);
                        const in_deduplication = ref(strategy);
                        const data = ref<Record<string, any>>({});
                        const options = computed(() => ({ get: { route: '/api/items/1' } }));
                        return { isCached, in_deduplication, data, options };
                    }
                );

                // Aguarda a 1ª requisição GET automática disparada na inicialização da store
                await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));
                const signal1: AbortSignal = axiosGet.mock.calls[0][1].signal;
                expect(signal1.aborted).toBe(false);

                // 2ª carga concorrente enquanto a 1ª está pendente
                store.reload();
                await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(2));
                const signal2: AbortSignal = axiosGet.mock.calls[1][1].signal;

                expect(signal1.aborted).toBe(true);
                expect(signal2.aborted).toBe(false);

                resolveGet1({ data: { id: 1, v: 1 } });
                resolveGet2({ data: { id: 1, v: 2 } });
                await vi.waitFor(() => expect(store.status.server.get.is_requested).toBe(true));
            }
        });

        it('Caso 3.1: Suporte a in_get_deduplication e options.in_get_deduplication', async () => {
            const promise1 = new Promise(() => {});
            const promise2 = new Promise((resolve) => resolve({ data: { id: 1 } }));

            const axiosGet = vi.fn().mockImplementation(() => {
                if (axiosGet.mock.calls.length === 1) return promise1;
                return promise2;
            });

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const in_get_deduplication = ref('cancel');
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/items/1' } }));
                    return { isCached, in_get_deduplication, data, options };
                }
            );

            // 1ª requisição em voo
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));
            const signal1: AbortSignal = axiosGet.mock.calls[0][1].signal;
            expect(signal1.aborted).toBe(false);

            // 2ª requisição aborta a 1ª
            store.reload();
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(2));
            expect(signal1.aborted).toBe(true);
        });

        it('Caso 4: Estratégias "ignore" e "first" ignoram novas requisições GET enquanto houver uma em andamento', async () => {
            const ignoreModes = ['ignore', 'first'] as const;

            for (const mode of ignoreModes) {
                let resolveGet!: (val: any) => void;
                const pendingPromise = new Promise((resolve) => { resolveGet = resolve; });

                const axiosGet = vi.fn().mockReturnValue(pendingPromise);

                const store = setupStore(
                    { axios: { get: axiosGet, post: vi.fn() } as any },
                    () => {
                        const isCached = ref(true);
                        const in_deduplication = ref(mode);
                        const data = ref<Record<string, any>>({});
                        const options = computed(() => ({ get: { route: '/api/items/1' } }));
                        return { isCached, in_deduplication, data, options };
                    }
                );

                // 1ª requisição em andamento
                await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));
                const signal: AbortSignal = axiosGet.mock.calls[0][1].signal;
                expect(signal.aborted).toBe(false);

                // Tenta recarregar 2 vezes enquanto a primeira está em voo
                store.reload();
                store.reload();

                expect(axiosGet).toHaveBeenCalledTimes(1);
                expect(signal.aborted).toBe(false);

                resolveGet({ data: { id: 1, name: 'Item Completo' } });
                await vi.waitFor(() => expect(store.status.server.get.is_requested).toBe(true));
            }
        });
    });

    describe('Cancelamento e Retry de Carga (cancelLoad)', () => {
        it('Caso 5: cancelLoad() aborta o sinal da requisição GET atual', async () => {
            const pendingPromise = new Promise(() => {});
            const axiosGet = vi.fn().mockReturnValue(pendingPromise);

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );

            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));
            const signal: AbortSignal = axiosGet.mock.calls[0][1].signal;
            expect(signal.aborted).toBe(false);

            store.cancelLoad();
            expect(signal.aborted).toBe(true);
        });

        it('Caso 5.1: cancelLoad(retryInSeconds) agenda uma nova tentativa após N segundos', async () => {
            const axiosGet = vi.fn().mockImplementation(() => Promise.resolve({ data: { success: true } }));

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            expect(axiosGet).toHaveBeenCalledTimes(1);

            // Cancela com retry em 3 segundos
            store.cancelLoad(3);

            // Antes de 3s, nenhuma nova chamada
            await vi.advanceTimersByTimeAsync(2000);
            expect(axiosGet).toHaveBeenCalledTimes(1);

            // Após completar 3s, nova chamada é efetuada
            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(2));
        });

        it('Caso 5.2: cancelLoad(true) usa o padrão de 5 segundos para retry', async () => {
            const axiosGet = vi.fn().mockImplementation(() => Promise.resolve({ data: { success: true } }));

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            expect(axiosGet).toHaveBeenCalledTimes(1);

            store.cancelLoad(true);

            await vi.advanceTimersByTimeAsync(4000);
            expect(axiosGet).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1000);
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(2));
        });
    });

    describe('Tratamento de Erros e CanceledError no GET', () => {
        it('Caso 6: CanceledError é silenciado e não marca server.get.is_error como true', async () => {
            const canceledError = new Error('Requisicao cancelada');
            canceledError.name = 'CanceledError';
            const axiosGet = vi.fn().mockRejectedValue(canceledError);

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(store.status.server.get.is_requested).toBe(true));

            expect(store.status.server.get.is_error).toBe(false);
            expect(store.status.server.get.error).toBeNull();
        });

        it('Caso 6.1: Erro real de rede marca server.get.is_error = true', async () => {
            const networkError = new Error('Network Error');
            networkError.name = 'AxiosError';
            const axiosGet = vi.fn().mockRejectedValue(networkError);

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(store.status.server.get.is_requested).toBe(true));

            expect(store.status.server.get.is_error).toBe(true);
            expect(store.status.server.get.error).toBe(networkError);
        });
    });

    describe('Ciclos de Cache, Hooks e Adapters', () => {
        it('Caso 7: Suporte a store.isShallow e hooks afterLoad / afterReload', async () => {
            const afterLoad = vi.fn();
            const afterReload = vi.fn();
            const axiosGet = vi.fn().mockResolvedValue({ data: { user: 'shallow_user' } });

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const isShallow = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/user' } }));
                    return { isCached, isShallow, data, options, afterLoad, afterReload };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
            expect(afterLoad).toHaveBeenCalled();

            await store.reload();
            expect(afterReload).toHaveBeenCalled();
            expect(store.data).toEqual({ user: 'shallow_user' });
        });

        it('Caso 8: only_cache impede requisição de rede após carregar cache', async () => {
            const localforage = (await import('localforage')).default;
            vi.spyOn(localforage, 'getItem').mockResolvedValueOnce({ data: { fromCache: true } });

            const axiosGet = vi.fn();
            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const only_cache = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, only_cache, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(store.status.cache.get.is_requested).toBe(true));

            expect(store.data).toEqual({ fromCache: true });
            expect(axiosGet).not.toHaveBeenCalled();
        });

        it('Caso 9: Cache corrompido limpa a chave e continua', async () => {
            const localforage = (await import('localforage')).default;
            const removeItemSpy = vi.spyOn(localforage, 'removeItem').mockResolvedValue(null as any);

            const corruptedCache: any = {
                data: { ok: true },
                get extra() {
                    throw new Error('Corrupted cache data');
                }
            };
            vi.spyOn(localforage, 'getItem').mockResolvedValueOnce(corruptedCache);

            const axiosGet = vi.fn().mockResolvedValue({ data: { fallback: true } });
            setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const extra = ref('initial');
                    const inCache = ['extra'];
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, extra, inCache, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(removeItemSpy).toHaveBeenCalled());
        });

        it('Caso 10: Falha ao ler cache (getItem reject) atualiza status.cache.get', async () => {
            const localforage = (await import('localforage')).default;
            vi.spyOn(localforage, 'getItem').mockRejectedValueOnce(new Error('IndexedDB blocked'));

            const axiosGet = vi.fn().mockResolvedValue({ data: {} });
            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(store.status.cache.get.is_requested).toBe(true));

            expect(store.status.cache.get.is_error).toBe(true);
            expect(store.status.cache.get.is_success).toBe(false);
        });

        it('Caso 11: Loading adapter e watchValid de loading_options.message', async () => {
            const startMock = vi.fn();
            const updateMock = vi.fn();
            const stopMock = vi.fn();

            const store = setupStore(
                {
                    axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any,
                    loading: { start: startMock, update: updateMock, stop: stopMock }
                },
                () => {
                    const isCached = ref(true);
                    const id = ref('user-1');
                    const data = ref<Record<string, any>>({});
                    const loading_options = ref({ message: 'Carregando perfil...', target: 'modal' });
                    const options = computed(() => ({ get: { route: '/api/user' } }));
                    return { isCached, id, data, loading_options, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            expect(startMock).toHaveBeenCalled();

            // Altera mensagem de loading
            store.loading_options.message = 'Processando dados...';
            await (await import('vue')).nextTick();
            expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
                message: 'Processando dados...',
                target: 'modal'
            }));

            // Altera id da store, acionando watch(key) que para o loading do key anterior
            store.id = 'user-2';
            await (await import('vue')).nextTick();
            expect(stopMock).toHaveBeenCalled();
        });

        it('Caso 12: clearAll limpa todo o armazenamento localforage', async () => {
            const localforage = (await import('localforage')).default;
            const clearSpy = vi.spyOn(localforage, 'clear').mockResolvedValue(null as any);

            const store = setupStore(
                { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    return { isCached, data };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await store.clearAll();
            expect(clearSpy).toHaveBeenCalled();
        });

        it('Caso 13: Lazy loading de axios quando não provido na config inicial', async () => {
            const store = setupStore(
                {}, // sem axios na config
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({ val: 1 });
                    const options = computed(() => ({ save: '/api/save' }));
                    return { isCached, data, options };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            // Salvar no servidor acionará resolve() e import lazy do axios
            await store.saveInServer().catch(() => {});
        });

        it('Caso 14: isShallow com dados carregados do cache', async () => {
            const localforage = (await import('localforage')).default;
            vi.spyOn(localforage, 'getItem').mockResolvedValueOnce({ data: { shallowKey: 'fromCache' } });

            const store = setupStore(
                { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const isShallow = ref(true);
                    const data = ref<Record<string, any>>({});
                    return { isCached, isShallow, data };
                }
            );

            await vi.advanceTimersByTimeAsync(10);
            await vi.waitFor(() => expect(store.status.cache.get.is_requested).toBe(true));
            expect(store.data).toEqual({ shallowKey: 'fromCache' });
        });

        it('Caso 15: Disparo de evento status-updated no document global', async () => {
            const dispatchMock = vi.fn();
            const originalDoc = (globalThis as any).document;
            (globalThis as any).document = { dispatchEvent: dispatchMock };

            try {
                const store = setupStore(
                    { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
                    () => {
                        const isCached = ref(true);
                        const data = ref<Record<string, any>>({});
                        return { isCached, data };
                    }
                );

                store.status.server.get.is_success = true;
                await (await import('vue')).nextTick();
                expect(dispatchMock).toHaveBeenCalled();
            } finally {
                (globalThis as any).document = originalDoc;
            }
        });
    });
});
