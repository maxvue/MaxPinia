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
        await vi.waitFor(() => expect(store.data).toEqual({ value: 'LEGIT_RELOAD' }));

        firstResponse.resolve({ data: { value: 'FIRST_FETCH' } });
        await Promise.resolve();
        await nextTick();

        expect(store.data).toEqual({ value: 'LEGIT_RELOAD' });
        expect(store.receivedMetas).toEqual([{ seq: 2, projectId: 'A' }]);
    });

    describe('T9: options.id na identidade efetiva e precedência de store.id', () => {
        it('options.id reativo carrega nova identidade quando store.id é ausente', async () => {
            const cacheA = deferred<any>();
            const cacheB = deferred<any>();
            storage.getItem.mockImplementation((key: string) => key.endsWith('.A') ? cacheA.promise : cacheB.promise);

            const optId = ref('A');
            const pinia = createPinia();
            pinia.use(createMaxPinia({ axios: { get: vi.fn(), post: vi.fn() } }));
            const app = createApp(defineComponent({ render: () => null }));
            app.use(pinia);
            setActivePinia(pinia);

            const useStore = defineStore(`read.opt_identity.${++storeCounter}`, () => {
                const isCached = ref(true);
                const only_cache = ref(true);
                const data = ref<any>(null);
                const options = computed(() => ({
                    id: optId.value,
                    get: { route: '/items' }
                }));
                return { isCached, only_cache, data, options };
            });

            const store = useStore();

            await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(expect.stringMatching(/\.A$/)));

            // Troca options.id para B com store.id ausente
            optId.value = 'B';
            await nextTick();

            await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(expect.stringMatching(/\.B$/)));

            // B resolve primeiro
            cacheB.resolve({ data: { title: 'Item B' } });
            await vi.waitFor(() => expect(store.data).toEqual({ title: 'Item B' }));

            // A resolve atrasado: deve ser descartado
            cacheA.resolve({ data: { title: 'Item A atrasado' } });
            await Promise.resolve();
            await nextTick();

            expect(store.data).toEqual({ title: 'Item B' });
        });

        it('store.id definido tem prioridade estrita e ignora mudanças em options.id', async () => {
            const axiosGet = vi.fn().mockResolvedValue({ data: { name: 'Fixed' } });
            const optId = ref('opt-1');

            const pinia = createPinia();
            pinia.use(createMaxPinia({ axios: { get: axiosGet, post: vi.fn() } }));
            const app = createApp(defineComponent({ render: () => null }));
            app.use(pinia);
            setActivePinia(pinia);

            const useStore = defineStore(`read.priority_identity.${++storeCounter}`, () => {
                const isCached = ref(true);
                const id = ref('store-fixed-id');
                const data = ref<any>(null);
                const options = computed(() => ({
                    id: optId.value,
                    get: { route: '/fixed' }
                }));
                return { isCached, id, data, options };
            });

            const store = useStore();

            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1));

            // Altera options.id, mas store.id continua sendo 'store-fixed-id'
            optId.value = 'opt-2';
            await nextTick();
            await nextTick();

            // Nenhuma nova requisição deve ser feita porque a chave efetiva não mudou
            expect(axiosGet).toHaveBeenCalledTimes(1);
        });

        it('chave correta no saveInCache após carregar nova identidade', async () => {
            const setItemCalls: { key: string; val: any }[] = [];
            storage.setItem.mockImplementation((key: string, val: any) => {
                setItemCalls.push({ key, val });
                return Promise.resolve(null);
            });

            const currentId = ref('doc-1');
            const pinia = createPinia();
            pinia.use(createMaxPinia({ axios: { get: vi.fn(), post: vi.fn() } }));
            const app = createApp(defineComponent({ render: () => null }));
            app.use(pinia);
            setActivePinia(pinia);

            const useStore = defineStore(`read.save_cache_id.${++storeCounter}`, () => {
                const isCached = ref(true);
                const only_cache = ref(true);
                const id = currentId;
                const data = ref<any>({ content: 'Initial 1' });
                return { isCached, only_cache, id, data };
            });

            const store = useStore();

            await store.saveInCache();
            expect(setItemCalls.some(c => c.key.endsWith('.doc-1'))).toBe(true);

            // Troca id para doc-2
            currentId.value = 'doc-2';
            store.data = { content: 'Initial 2' };
            await nextTick();

            await store.saveInCache();
            expect(setItemCalls.some(c => c.key.endsWith('.doc-2'))).toBe(true);
        });
    });
});

