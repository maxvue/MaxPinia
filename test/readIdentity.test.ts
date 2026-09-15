import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, defineComponent, nextTick, ref } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { createMaxPinia } from '../src';

const storage = vi.hoisted(() => ({
    getItem: vi.fn(),
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

let storeCounter = 0;

function setupStore(axios: any, onlyCache = false) {
    const pinia = createPinia();
    pinia.use(createMaxPinia({ axios }));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);

    const useStore = defineStore(`read.identity.${++storeCounter}`, () => {
        const isCached = ref(true);
        const only_cache = ref(onlyCache);
        const id = ref('A');
        const data = ref<Record<string, any>>({});
        const requestSequence = ref(0);
        const createdMetas = ref<any[]>([]);
        const receivedMetas = ref<any[]>([]);
        const options = computed(() => ({
            get: { route: '/projects', data: { project_id: id.value } }
        }));
        const createRequestMeta = () => {
            const meta = { seq: ++requestSequence.value, projectId: id.value };
            createdMetas.value.push(meta);
            return meta;
        };
        const onServerData = vi.fn((value: any, meta: any) => {
            receivedMetas.value.push(meta);
            if (meta.projectId === id.value) data.value = value;
        });

        return {
            isCached,
            only_cache,
            id,
            data,
            options,
            createRequestMeta,
            onServerData,
            createdMetas,
            receivedMetas
        };
    });

    return useStore();
}

describe('Identidade causal de leituras', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storage.getItem.mockReset();
        storage.getItem.mockResolvedValue(null);
        storage.setItem.mockResolvedValue(null);
    });

    it('captura metadados antes de aguardar o Axios e não envia a requisição do projeto anterior', async () => {
        const axiosDependency = deferred<any>();
        const axiosGet = vi.fn().mockResolvedValue({ data: { projectId: 'B' } });
        const store = setupStore(axiosDependency.promise as any);

        await vi.waitFor(() => expect(store.createdMetas).toHaveLength(1));
        expect(store.createdMetas[0]).toEqual({ seq: 1, projectId: 'A' });
        expect(axiosGet).not.toHaveBeenCalled();

        store.id = 'B';
        await nextTick();
        await vi.waitFor(() => expect(store.createdMetas).toHaveLength(2));
        expect(store.createdMetas[1]).toEqual({ seq: 2, projectId: 'B' });

        axiosDependency.resolve({ get: axiosGet, post: vi.fn() });

        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(store.data).toEqual({ projectId: 'B' }));
        expect(axiosGet.mock.calls[0][0]).toBe('/projects?project_id=B');
        expect(store.receivedMetas).toEqual([{ seq: 2, projectId: 'B' }]);
    });

    it('descarta cache de A que resolve depois da troca para B', async () => {
        const cacheA = deferred<any>();
        const cacheB = deferred<any>();
        storage.getItem.mockImplementation((key: string) => key.endsWith('.A') ? cacheA.promise : cacheB.promise);

        const store = setupStore({ get: vi.fn(), post: vi.fn() }, true);
        await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(expect.stringMatching(/\.A$/)));

        store.id = 'B';
        await nextTick();
        await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(expect.stringMatching(/\.B$/)));

        cacheB.resolve({ data: { projectId: 'B', source: 'cache' } });
        await vi.waitFor(() => expect(store.data).toEqual({ projectId: 'B', source: 'cache' }));

        cacheA.resolve({ data: { projectId: 'A', source: 'cache-atrasado' } });
        await Promise.resolve();
        await nextTick();

        expect(store.data).toEqual({ projectId: 'B', source: 'cache' });
    });

    it('mantém o reload legítimo como vencedor quando a resposta anterior chega por último', async () => {
        const firstResponse = deferred<any>();
        const reloadResponse = deferred<any>();
        const axiosGet = vi.fn()
            .mockReturnValueOnce(firstResponse.promise)
            .mockReturnValueOnce(reloadResponse.promise);
        const store = setupStore({ get: axiosGet, post: vi.fn() });

        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));
        const reloadPromise = store.reload();
        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(2));

        reloadResponse.resolve({ data: { value: 'LEGIT_RELOAD' } });
        await reloadPromise;
        expect(store.data).toEqual({ value: 'LEGIT_RELOAD' });

        firstResponse.resolve({ data: { value: 'FIRST_FETCH' } });
        await Promise.resolve();
        await nextTick();

        expect(store.data).toEqual({ value: 'LEGIT_RELOAD' });
        expect(store.receivedMetas).toEqual([{ seq: 2, projectId: 'A' }]);
    });
});
