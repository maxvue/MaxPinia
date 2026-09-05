import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, defineComponent, ref, computed } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { createMaxPinia } from '../src';
import localforage from 'localforage';

const instances: Map<string, any> = new Map();

function getOrCreateInstance(options: { name?: string; storeName?: string } = {}) {
    const key = `${options.name || 'pinia'}:${options.storeName || 'max-pinia-cache'}`;
    if (!instances.has(key)) {
        instances.set(key, {
            name: options.name,
            storeName: options.storeName,
            config: vi.fn(),
            getItem: vi.fn().mockResolvedValue(null),
            setItem: vi.fn().mockResolvedValue(null),
            removeItem: vi.fn().mockResolvedValue(null),
            clear: vi.fn().mockResolvedValue(null),
            keys: vi.fn().mockResolvedValue([])
        });
    }
    return instances.get(key);
}

vi.mock('localforage', () => {
    const defaultInstance = {
        config: vi.fn(),
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(null),
        removeItem: vi.fn().mockResolvedValue(null),
        clear: vi.fn().mockResolvedValue(null),
        keys: vi.fn().mockResolvedValue([]),
        createInstance: vi.fn((opts?: any) => getOrCreateInstance(opts))
    };
    return {
        default: defaultInstance
    };
});

function setupStore(storeId: string, config: Parameters<typeof createMaxPinia>[0], storeSetup: () => any) {
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore(storeId, storeSetup)();
}

describe('Isolamento de Storage e Deleção Segura (Issue #6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        instances.clear();
    });

    it('Cenário 1: Stores com bancos diferentes (cache_name) criam instâncias isoladas no localforage', () => {
        const storeA = setupStore('storeA', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const cache_name = ref('db-alpha');
            const data = ref<Record<string, any>>({ user: 'alpha' });
            return { isCached, cache_name, data };
        });

        const storeB = setupStore('storeB', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const cache_name = ref('db-beta');
            const data = ref<Record<string, any>>({ user: 'beta' });
            return { isCached, cache_name, data };
        });

        expect(localforage.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'db-alpha' })
        );
        expect(localforage.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'db-beta' })
        );
        expect(localforage.createInstance).toHaveBeenCalledTimes(2);
    });

    it('Cenário 1.1: Operações de saveInCache gravam estritamente na respectiva instância isolada', async () => {
        const instanceAlpha = getOrCreateInstance({ name: 'db-alpha', storeName: 'max-pinia-cache' });
        const instanceBeta = getOrCreateInstance({ name: 'db-beta', storeName: 'max-pinia-cache' });

        const storeA = setupStore('storeA_io', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const cache_name = ref('db-alpha');
            const data = ref<Record<string, any>>({ user: 'alpha-data' });
            return { isCached, cache_name, data };
        });

        const storeB = setupStore('storeB_io', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const cache_name = ref('db-beta');
            const data = ref<Record<string, any>>({ user: 'beta-data' });
            return { isCached, cache_name, data };
        });

        await storeA.saveInCache();

        expect(instanceAlpha.setItem).toHaveBeenCalledWith(
            'storeA_io.global',
            expect.objectContaining({ data: { user: 'alpha-data' } })
        );
        expect(instanceBeta.setItem).not.toHaveBeenCalled();

        await storeB.saveInCache();

        expect(instanceBeta.setItem).toHaveBeenCalledWith(
            'storeB_io.global',
            expect.objectContaining({ data: { user: 'beta-data' } })
        );
    });

    it('Cenário 2: Stores suportam storeName / store_name customizado por store', () => {
        setupStore('storeCustom1', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const storeName = 'custom-table-1';
            const data = ref({});
            return { isCached, storeName, data };
        });

        setupStore('storeCustom2', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const store_name = 'custom-table-2';
            const data = ref({});
            return { isCached, store_name, data };
        });

        setupStore('storeCustom3', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const options = { storeName: 'custom-table-3' };
            const data = ref({});
            return { isCached, options, data };
        });

        setupStore('storeCustom4', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const options = { store_name: 'custom-table-4' };
            const data = ref({});
            return { isCached, options, data };
        });

        expect(localforage.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({ storeName: 'custom-table-1' })
        );
        expect(localforage.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({ storeName: 'custom-table-2' })
        );
        expect(localforage.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({ storeName: 'custom-table-3' })
        );
        expect(localforage.createInstance).toHaveBeenCalledWith(
            expect.objectContaining({ storeName: 'custom-table-4' })
        );
    });

    it('Cenário 3: store.clearAll() limpa cirurgicamente apenas chaves da store atual sem invocar clear() global', async () => {
        const instance = getOrCreateInstance({ name: 'pinia', storeName: 'max-pinia-cache' });
        instance.keys.mockResolvedValue([
            'storeA.global',
            'storeA.user-1',
            'storeA',
            'storeB.global',
            'storeB.item-2',
            'storeAB.global'
        ]);

        const storeA = setupStore('storeA', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const data = ref({});
            return { isCached, data };
        });

        await storeA.clearAll();

        // Não deve ter chamado clear global
        expect(instance.clear).not.toHaveBeenCalled();
        expect(localforage.clear).not.toHaveBeenCalled();

        // Deve remover apenas as chaves da storeA
        expect(instance.removeItem).toHaveBeenCalledWith('storeA.global');
        expect(instance.removeItem).toHaveBeenCalledWith('storeA.user-1');
        expect(instance.removeItem).toHaveBeenCalledWith('storeA');

        // NÃO deve remover chaves de storeB ou storeAB
        expect(instance.removeItem).not.toHaveBeenCalledWith('storeB.global');
        expect(instance.removeItem).not.toHaveBeenCalledWith('storeB.item-2');
        expect(instance.removeItem).not.toHaveBeenCalledWith('storeAB.global');
        expect(instance.removeItem).toHaveBeenCalledTimes(3);
    });

    it('Cenário 4: clearAll() trata erros com resiliência se keys() ou removeItem() falharem', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const instance = getOrCreateInstance({ name: 'pinia', storeName: 'max-pinia-cache' });
        instance.keys.mockRejectedValueOnce(new Error('IndexedDB locked'));

        const store = setupStore('storeErr', { axios: { get: vi.fn(), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const data = ref({});
            return { isCached, data };
        });

        await expect(store.clearAll()).resolves.toBeUndefined();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[max-pinia] CLEAR ALL ERROR:'),
            expect.any(Error)
        );

        consoleErrorSpy.mockRestore();
    });

    it('Cenário 5: Fallback defensivo funciona quando localforage.createInstance não é suportado', async () => {
        const originalCreateInstance = localforage.createInstance;
        // Simula ambiente onde createInstance não está disponível
        (localforage as any).createInstance = undefined;

        const store = setupStore('storeFallback', { axios: { get: vi.fn(), post: vi.fn() } as any, storeName: 'legacy-store' }, () => {
            const isCached = ref(true);
            const cache_name = ref('legacy-db');
            const data = ref({});
            return { isCached, cache_name, data };
        });

        expect(localforage.config).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'legacy-db', storeName: 'legacy-store' })
        );

        // Restaura
        localforage.createInstance = originalCreateInstance;
    });
});
