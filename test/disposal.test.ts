import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, ref, computed, effectScope } from 'vue';
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
    return defineStore(`test.disposal.${storeCounter}`, storeSetup)();
}

describe('T4 — Descarte Terminal e Idempotente ($dispose e onScopeDispose)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('store.$dispose() aborta requisições em voo, cancela retry e impede novos efeitos', async () => {
        let signalGet!: AbortSignal;
        let resolveGet!: (val: any) => void;
        const getPromise = new Promise((resolve) => { resolveGet = resolve; });
        const axiosGet = vi.fn((_url: string, cfg: any) => {
            signalGet = cfg.signal;
            return getPromise;
        });

        const store = setupStore(
            { axios: { get: axiosGet, post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ v: 1 });
                const options = computed(() => ({ get: { route: '/api/data' } }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);
        expect(signalGet.aborted).toBe(false);

        // Agenda um cancelLoad com retry de 5 segundos
        store.cancelLoad(5);
        expect(signalGet.aborted).toBe(true);

        // Descarta a store antes do retry disparar
        store.$dispose();

        // Avança o tempo além do retry (5s)
        await vi.advanceTimersByTimeAsync(6000);

        // Nenhuma nova requisição GET deve ter ocorrido
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Resposta tardia que chegue após o descarte não altera dados
        resolveGet({ data: { v: 999 } });
        await vi.advanceTimersByTimeAsync(10);
        expect(store.data).toEqual({ v: 1 });
    });

    it('Debounce de autosave agendado vira no-op se a store for descartada antes dos 300ms', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { ok: true } });

        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ initial: 'value' });
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        expect(store.is_save_in_pause).toBe(false);

        // Edita store.data agendando autosave (300ms)
        store.data.initial = 'updated';
        await vi.advanceTimersByTimeAsync(100);

        // Descarta aos 100ms (antes do disparo aos 300ms)
        store.$dispose();

        // Avança até os 500ms
        await vi.advanceTimersByTimeAsync(500);

        // POST não deve ter sido enviado
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('Descarte duplicado ou subsequente é idempotente e seguro', async () => {
        const store = setupStore(
            { axios: { get: vi.fn(), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({});
                return { isCached, data };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        expect(() => {
            store.$dispose();
            store.$dispose();
            store.$dispose();
        }).not.toThrow();
    });

    it('Desabilitar (enabled = false) não é descarte definitivo e permite reativação', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { message: 'hello' } });

        const store = setupStore(
            { axios: { get: axiosGet, post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const enabled = ref(true);
                const data = ref<Record<string, any>>({});
                const options = computed(() => ({ get: { route: '/api/data' } }));
                return { isCached, enabled, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Desabilita store
        store.enabled = false;
        await vi.advanceTimersByTimeAsync(10);

        // Reativa store
        store.enabled = true;
        await vi.advanceTimersByTimeAsync(10);

        // Carga de cache e servidor reativada com sucesso
        expect(axiosGet).toHaveBeenCalledTimes(2);
    });

    it('onScopeDispose em escopo Vue encerra a store adequadamente', async () => {
        const axiosGet = vi.fn().mockReturnValue(new Promise(() => {}));
        let storeRef: any;

        const scope = effectScope();
        scope.run(() => {
            storeRef = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({});
                    const options = computed(() => ({ get: { route: '/api/data' } }));
                    return { isCached, data, options };
                }
            );
        });

        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Para o escopo
        scope.stop();

        // Operações subsequentes são ignoradas
        await storeRef.saveInServer();
        expect(storeRef.status.server.save.is_requesting).toBe(false);
    });
});
