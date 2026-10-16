import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, ref, computed } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { createMaxPinia } from '../src';

vi.mock('localforage', () => {
    const mockStorageInstance = {
        config: vi.fn(),
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(null),
        removeItem: vi.fn().mockResolvedValue(null),
        clear: vi.fn().mockResolvedValue(null),
        keys: vi.fn().mockResolvedValue([]),
        createInstance: vi.fn()
    };
    mockStorageInstance.createInstance = vi.fn((_opts?: any) => mockStorageInstance);
    return {
        default: mockStorageInstance
    };
});

let storeCounter = 0;

function setupStore(config: Parameters<typeof createMaxPinia>[0], storeSetup: () => any) {
    storeCounter++;
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore(`test.asyncCompletion.${storeCounter}`, storeSetup)();
}

describe('T2 — Conclusão Assíncrona e Cadeias de Promessas', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reload() e saveInServer() retornam Promise<void> e aguardam finalização completa de HTTP e cache', async () => {
        let resolveGet!: (val: any) => void;
        const getPromise = new Promise((resolve) => { resolveGet = resolve; });
        const axiosGet = vi.fn().mockReturnValue(getPromise);

        let resolvePost!: (val: any) => void;
        const postPromise = new Promise((resolve) => { resolvePost = resolve; });
        const axiosPost = vi.fn().mockReturnValue(postPromise);

        let afterReloadCalled = false;

        const store = setupStore(
            { axios: { get: axiosGet, post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ initial: true });
                const options = computed(() => ({
                    get: { route: '/api/data' },
                    save: '/api/save'
                }));
                const afterReload = () => { afterReloadCalled = true; };
                return { isCached, data, options, afterReload };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // Testa reload()
        let reloadResolved = false;
        const reloadPromise = store.reload().then(() => { reloadResolved = true; });

        // Antes de resolver HTTP, reloadPromise continua pendente e afterReload não foi chamado
        await vi.advanceTimersByTimeAsync(10);
        expect(reloadResolved).toBe(false);
        expect(afterReloadCalled).toBe(false);

        // Resolve GET HTTP
        resolveGet({ data: { remoteKey: 'remoteValue' } });
        await reloadPromise;

        expect(reloadResolved).toBe(true);
        expect(afterReloadCalled).toBe(true);
        expect(store.data).toEqual({ remoteKey: 'remoteValue' });
        expect(store.status.server.get.is_success).toBe(true);

        // Testa saveInServer()
        let saveResolved = false;
        const savePromise = store.saveInServer().then(() => { saveResolved = true; });

        await vi.advanceTimersByTimeAsync(10);
        expect(saveResolved).toBe(false);

        resolvePost({ data: { ok: true } });
        await savePromise;

        expect(saveResolved).toBe(true);
        expect(store.status.server.save.is_success).toBe(true);
        expect(store.status.server.save.is_requesting).toBe(false);
    });

    it('reload() e saveInServer() resolvem imediatamente quando não há rota configurada', async () => {
        const store = setupStore(
            { axios: { get: vi.fn(), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ val: 1 });
                return { isCached, data }; // sem get.route nem save
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        let reloadFinished = false;
        await store.reload().then(() => { reloadFinished = true; });
        expect(reloadFinished).toBe(true);

        let saveFinished = false;
        await store.saveInServer().then(() => { saveFinished = true; });
        expect(saveFinished).toBe(true);
    });

    it('Erros operacionais de HTTP resolvem a promessa pública e registram status de erro', async () => {
        const axiosGet = vi.fn().mockRejectedValue(new Error('Network Error 500'));
        const axiosPost = vi.fn().mockRejectedValue(new Error('Backend Validation Failed 422'));

        let afterReloadCalled = false;

        const store = setupStore(
            { axios: { get: axiosGet, post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ val: 1 });
                const options = computed(() => ({
                    get: { route: '/api/get-error' },
                    save: '/api/post-error'
                }));
                const afterReload = () => { afterReloadCalled = true; };
                return { isCached, data, options, afterReload };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // reload não lança erro não tratado, mas resolve e atualiza status
        await expect(store.reload()).resolves.toBeUndefined();
        expect(store.status.server.get.is_error).toBe(true);
        expect(store.status.server.get.is_success).toBe(false);
        expect(afterReloadCalled).toBe(true);

        // saveInServer não lança erro não tratado, mas resolve e atualiza status
        await expect(store.saveInServer()).resolves.toBeUndefined();
        expect(store.status.server.save.is_error).toBe(true);
        expect(store.status.server.save.is_success).toBe(false);
    });

    it('Exceção síncrona em resolveRoute ou createRequestMeta finaliza status sem deixar locks pendentes', async () => {
        const badResolveRoute = vi.fn(() => {
            throw new Error('Falha na resolução de rota');
        });

        const store = setupStore(
            {
                axios: { get: vi.fn(), post: vi.fn() } as any,
                resolveRoute: badResolveRoute
            },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({});
                const options = computed(() => ({ get: { route: 'bad.route' } }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.reload();

        expect(store.status.server.get.is_requesting).toBe(false);
        expect(store.status.server.get.is_requested).toBe(true);
        expect(store.status.server.get.is_error).toBe(true);
        expect(store.status.server.get.error?.message).toBe('Falha na resolução de rota');
    });

    it('Pausa de gravação é balanceada mesmo se onServerData lançar erro', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { corrupted: true } });

        const store = setupStore(
            { axios: { get: axiosGet, post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({});
                const options = computed(() => ({ get: { route: '/api/data' } }));
                const onServerData = () => {
                    throw new Error('Erro de parsing do consumidor');
                };
                return { isCached, data, options, onServerData };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.reload();

        // pauseSave e resumeSave foram balanceados: a pausa deve ser liberada
        await vi.advanceTimersByTimeAsync(20);
        expect(store.is_save_in_pause).toBe(false);
    });
});
