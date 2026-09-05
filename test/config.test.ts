import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import localforage from 'localforage';

function setup(config: Parameters<typeof createMaxPinia>[0], storeSetup: () => any) {
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore('test.store', storeSetup)();
}

const cachedStoreSetup = () => {
    const isCached = ref(true);
    const data = ref<Record<string, any>>({});
    const options = computed(() => ({ get: { route: 'my.route', data: { id: 7 } } }));
    return { isCached, data, options };
};

describe('createMaxPinia config', () => {
    beforeEach(() => vi.clearAllMocks());

    it('usa resolveRoute para montar a URL do GET', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { ok: true } });
        const resolveRoute = vi.fn((route: string, params?: Record<string, any>) => `/resolved/${route}/${params?.id}`);
        setup({ axios: { get: axiosGet, post: vi.fn() } as any, resolveRoute }, cachedStoreSetup);
        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
        expect(resolveRoute).toHaveBeenCalledWith('my.route', { id: 7 });
        expect(axiosGet.mock.calls[0][0]).toBe('/resolved/my.route/7');
    });

    it('sem resolveRoute, mantém comportamento de URL literal + query string', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { ok: true } });
        setup({ axios: { get: axiosGet, post: vi.fn() } as any }, cachedStoreSetup);
        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
        expect(axiosGet.mock.calls[0][0]).toBe('my.route?id=7');
    });

    it('anexa query string com & quando a rota base configurada já possui parâmetros', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { ok: true } });
        setup({ axios: { get: axiosGet, post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({});
            const options = computed(() => ({
                get: {
                    route: '/api/v1/orders?type=open',
                    data: { page: 1 }
                }
            }));
            return { isCached, data, options };
        });
        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
        expect(axiosGet.mock.calls[0][0]).toBe('/api/v1/orders?type=open&page=1');
    });

    it('usa resolveRoute na URL do POST (saveInServer)', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const resolveRoute = vi.fn((route: string) => `/resolved/${route}`);
        const store = setup({ axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any, resolveRoute }, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ name: 'x' });
            const options = computed(() => ({ save: 'my.save.route' }));
            return { isCached, data, options };
        });
        store.saveInServer();
        await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());
        expect(axiosPost.mock.calls[0][0]).toBe('/resolved/my.save.route');
    });

    it('chama onActivity em load e save', async () => {
        const onActivity = vi.fn();
        const store = setup({ axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn().mockResolvedValue({ data: {} }) } as any, onActivity }, cachedStoreSetup);
        await vi.waitFor(() => expect(onActivity).toHaveBeenCalled());
        const callsAfterLoad = onActivity.mock.calls.length;
        store.saveInServer();
        await vi.waitFor(() => expect(onActivity.mock.calls.length).toBeGreaterThan(callsAfterLoad));
    });

    it('repassa storeName customizado ao localforage', async () => {
        setup({ axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any, storeName: 'pinia-with-cache-plugin' }, cachedStoreSetup);
        expect(localforage.config).toHaveBeenCalledWith(expect.objectContaining({ storeName: 'pinia-with-cache-plugin' }));
    });

    it('não envia header X-CSRF-TOKEN quando getSessionToken retorna null ou não é informado', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setup(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ name: 'test' });
                const options = computed(() => ({ save: 'my.save.route' }));
                return { isCached, data, options };
            }
        );

        store.saveInServer();
        await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());

        const postConfig = axiosPost.mock.calls[0][2];
        expect(postConfig.headers).not.toHaveProperty('X-CSRF-TOKEN');
    });

    it('envia header X-CSRF-TOKEN quando getSessionToken retorna um token válido', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setup(
            {
                axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any,
                getSessionToken: () => 'csrf-secret-abc-123'
            },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ name: 'test' });
                const options = computed(() => ({ save: 'my.save.route' }));
                return { isCached, data, options };
            }
        );

        store.saveInServer();
        await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());

        const postConfig = axiosPost.mock.calls[0][2];
        expect(postConfig.headers['X-CSRF-TOKEN']).toBe('csrf-secret-abc-123');
    });

    it('não envia header X-CSRF-TOKEN quando getSessionToken retorna string vazia ou undefined', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setup(
            {
                axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any,
                getSessionToken: () => ''
            },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ name: 'test' });
                const options = computed(() => ({ save: 'my.save.route' }));
                return { isCached, data, options };
            }
        );

        store.saveInServer();
        await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());

        const postConfig = axiosPost.mock.calls[0][2];
        expect(postConfig.headers).not.toHaveProperty('X-CSRF-TOKEN');
    });
});

