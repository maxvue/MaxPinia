import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, ref, computed, nextTick } from 'vue';
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

function setupStore(config: Parameters<typeof createMaxPinia>[0] = {}, storeOptions: Record<string, any> = {}) {
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);

    const useTestStore = defineStore('test.cancelLoad', () => {
        const isCached = ref(true);
        const data = ref<Record<string, any>>({});
        const enabled = ref(storeOptions.enabled ?? true);
        const options = computed(() => ({
            get: { route: 'items.route' },
            ...(storeOptions.options ?? {})
        }));
        return { isCached, data, enabled, options };
    });

    return useTestStore();
}

describe('cancelLoad', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('substitui retry anterior ao chamar cancelLoad novamente (sem disparos órfãos)', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { id: 1 } });
        const store = setupStore({ axios: { get: axiosGet, post: vi.fn() } as any });

        // Aguarda a inicialização padrão
        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Agenda retry para 5s e em seguida substitui por 10s
        store.cancelLoad(5);
        store.cancelLoad(10);

        // Avança 5s: o primeiro timer NÃO deve disparar
        await vi.advanceTimersByTimeAsync(5000);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Avança mais 5s (total 10s): o segundo timer DEVE disparar exatamente 1 vez
        await vi.advanceTimersByTimeAsync(5000);
        expect(axiosGet).toHaveBeenCalledTimes(2);
    });

    it('cancela definitivamente sem reagendar quando cancelLoad() for chamado sem argumentos ou com null/false', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { id: 1 } });
        const store = setupStore({ axios: { get: axiosGet, post: vi.fn() } as any });

        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Agenda retry para 5s
        store.cancelLoad(5);

        // Cancela definitivamente
        store.cancelLoad();

        // Avança 10s: nenhuma requisição adicional deve ser executada
        await vi.advanceTimersByTimeAsync(10000);
        expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('limpa timer e cancela requisições quando store.enabled for alterado para false', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { id: 1 } });
        const store = setupStore({ axios: { get: axiosGet, post: vi.fn() } as any });

        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // Agenda retry para 5s
        store.cancelLoad(5);

        // Desativa a store
        store.enabled = false;
        await nextTick();

        // Avança 10s: nenhuma requisição adicional deve ser executada
        await vi.advanceTimersByTimeAsync(10000);
        expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('aborta sinal da requisição ativa em andamento ao chamar cancelLoad', async () => {
        let capturedSignal: AbortSignal | undefined;
        const axiosGet = vi.fn().mockImplementation((_url: string, config: { signal?: AbortSignal }) => {
            capturedSignal = config.signal;
            return new Promise(() => {}); // pendente indefinidamente
        });

        const store = setupStore({ axios: { get: axiosGet, post: vi.fn() } as any });
        await vi.advanceTimersByTimeAsync(10);

        expect(axiosGet).toHaveBeenCalledTimes(1);
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Executa cancelLoad
        store.cancelLoad();

        expect(capturedSignal?.aborted).toBe(true);
    });

    it('trata retryInSeconds = true ou 0 como 5 segundos padrão', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { id: 1 } });
        const store = setupStore({ axios: { get: axiosGet, post: vi.fn() } as any });

        await vi.advanceTimersByTimeAsync(10);
        expect(axiosGet).toHaveBeenCalledTimes(1);

        // cancelLoad(true) deve usar 5s
        store.cancelLoad(true);
        await vi.advanceTimersByTimeAsync(4999);
        expect(axiosGet).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(axiosGet).toHaveBeenCalledTimes(2);

        // cancelLoad(0) deve usar 5s
        store.cancelLoad(0);
        await vi.advanceTimersByTimeAsync(4999);
        expect(axiosGet).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(axiosGet).toHaveBeenCalledTimes(3);
    });
});
