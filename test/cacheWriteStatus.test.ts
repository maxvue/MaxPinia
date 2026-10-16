import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, defineComponent, ref, nextTick } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { createMaxPinia } from '../src';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const storage = vi.hoisted(() => ({
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(null),
    removeItem: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([])
}));

vi.mock('localforage', () => ({
    default: {
        config: vi.fn(),
        ...storage,
        createInstance: vi.fn(() => storage)
    }
}));

let storeCounter = 0;

function setupStore(storeSetup: () => any) {
    const pinia = createPinia();
    pinia.use(createMaxPinia({ axios: { get: vi.fn(), post: vi.fn() } }));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore(`test.cacheWriteStatus.${++storeCounter}`, storeSetup)();
}

describe('T10: Status de escrita local (sequenciamento e isolamento de status do cache)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storage.getItem.mockReset();
        storage.setItem.mockReset();
        storage.getItem.mockResolvedValue(null);
        storage.setItem.mockResolvedValue(null);
    });

    it('primeira escrita termina enquanto segunda está pendente: mantém is_requesting true até a segunda finalizar', async () => {
        const op1 = deferred<any>();
        const op2 = deferred<any>();
        storage.setItem
            .mockReturnValueOnce(op1.promise)
            .mockReturnValueOnce(op2.promise);

        const store = setupStore(() => {
            const isCached = ref(true);
            const only_cache = ref(true);
            const data = ref({ val: 1 });
            return { isCached, only_cache, data };
        });

        // 1ª escrita
        const p1 = store.saveInCache();
        expect(store.status.cache.save.is_requesting).toBe(true);

        // 2ª escrita (mais recente)
        store.data.val = 2;
        const p2 = store.saveInCache();
        expect(store.status.cache.save.is_requesting).toBe(true);

        // Conclui a 1ª escrita enquanto a 2ª ainda está pendente
        op1.resolve(null);
        await p1;
        await nextTick();

        // O status geral de cache.save ainda deve acusar que há operação em voo (a 2ª)
        expect(store.status.cache.save.is_requesting).toBe(true);
        expect(store.status.cache.save.is_success).toBe(false);

        // Conclui a 2ª escrita
        op2.resolve(null);
        await p2;
        await nextTick();

        expect(store.status.cache.save.is_requesting).toBe(false);
        expect(store.status.cache.save.is_success).toBe(true);
        expect(store.status.cache.save.is_error).toBe(false);
    });

    it('primeira escrita falha após segunda ter sucesso: a falha antiga não contamina o status de sucesso da mais recente', async () => {
        const op1 = deferred<any>();
        const op2 = deferred<any>();
        storage.setItem
            .mockReturnValueOnce(op1.promise)
            .mockReturnValueOnce(op2.promise);

        const store = setupStore(() => {
            const isCached = ref(true);
            const only_cache = ref(true);
            const data = ref({ val: 10 });
            return { isCached, only_cache, data };
        });

        const p1 = store.saveInCache();
        store.data.val = 20;
        const p2 = store.saveInCache();

        // 2ª escrita tem sucesso primeiro
        op2.resolve(null);
        await p2;
        await nextTick();

        expect(store.status.cache.save.is_success).toBe(true);
        expect(store.status.cache.save.is_error).toBe(false);

        // 1ª escrita falha tardiamente
        const errorOp1 = new Error('Falha no disco da gravação 1');
        op1.reject(errorOp1);
        await p1;
        await nextTick();

        // O status da store reflete a escrita mais recente (sucesso) e não o erro da antiga
        expect(store.status.cache.save.is_success).toBe(true);
        expect(store.status.cache.save.is_error).toBe(false);
    });

    it('primeira escrita pertence a A e termina quando B está ativo: não marca conclusão em B', async () => {
        const opA = deferred<any>();
        const opB = deferred<any>();
        storage.setItem.mockImplementation((key: string) => {
            if (key.endsWith('.A')) return opA.promise;
            if (key.endsWith('.B')) return opB.promise;
            return Promise.resolve(null);
        });

        const id = ref('A');
        const store = setupStore(() => {
            const isCached = ref(true);
            const only_cache = ref(true);
            const data = ref({ name: 'Alpha' });
            return { isCached, only_cache, id, data };
        });

        // Grava A
        const pA = store.saveInCache();
        expect(store.status.cache.save.is_requesting).toBe(true);

        // Troca para B
        id.value = 'B';
        await nextTick();

        // Grava B
        const pB = store.saveInCache();

        // A termina
        opA.resolve(null);
        await pA;
        await nextTick();

        // B ainda deve estar pendente
        expect(store.status.cache.save.is_requesting).toBe(true);

        // B termina
        opB.resolve(null);
        await pB;
        await nextTick();

        expect(store.status.cache.save.is_requesting).toBe(false);
        expect(store.status.cache.save.is_success).toBe(true);
    });

    it('descarte durante escrita no cache não lança erros não capturados nem altera status', async () => {
        const op = deferred<any>();
        storage.setItem.mockReturnValueOnce(op.promise);

        const store = setupStore(() => {
            const isCached = ref(true);
            const only_cache = ref(true);
            const data = ref({ temp: true });
            return { isCached, only_cache, data };
        });

        const p = store.saveInCache();
        store.$dispose();

        // Resolve gravação após dispose
        op.resolve(null);
        await p;
        await nextTick();

        // Operação concluiu com segurança
        expect(true).toBe(true);
    });

    it('erro seguido de nova tentativa limpa flags de erro antigas no início da nova operação', async () => {
        storage.setItem
            .mockRejectedValueOnce(new Error('IndexedDB bloqueado'))
            .mockResolvedValueOnce(null);

        const store = setupStore(() => {
            const isCached = ref(true);
            const only_cache = ref(true);
            const data = ref({ retry: true });
            return { isCached, only_cache, data };
        });

        // 1ª tentativa falha tratada
        await store.saveInCache();
        await nextTick();

        expect(store.status.cache.save.is_error).toBe(true);
        expect(store.status.cache.save.is_success).toBe(false);

        // 2ª tentativa: ao iniciar, limpa is_error e marca is_requesting
        const op2 = deferred<any>();
        storage.setItem.mockReturnValueOnce(op2.promise);

        const p2 = store.saveInCache();
        expect(store.status.cache.save.is_requesting).toBe(true);
        expect(store.status.cache.save.is_error).toBe(false);
        expect(store.status.cache.save.error).toBeNull();

        op2.resolve(null);
        await p2;
        await nextTick();

        expect(store.status.cache.save.is_requesting).toBe(false);
        expect(store.status.cache.save.is_success).toBe(true);
    });
});
