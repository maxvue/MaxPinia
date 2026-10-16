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

let storeCounter = 0;

function setupStore(config: Parameters<typeof createMaxPinia>[0], storeSetup: () => any) {
    storeCounter++;
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore(`test.defaultData.${storeCounter}`, storeSetup)();
}

describe('T7: Defaults independentes (isolamento de referências e restauração)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('mutação de objeto/array aninhado em data não altera default_data nem initialData', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { success: true } });
        const store = setupStore(
            { axios: { get: vi.fn(), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref({
                    user: { name: 'Alice', tags: ['admin', 'dev'] },
                    counters: [1, 2, 3]
                });
                const default_data = {
                    user: { name: 'Alice', tags: ['admin', 'dev'] },
                    counters: [1, 2, 3]
                };
                return { isCached, data, default_data };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // Modifica profundamente store.data
        store.data.user.name = 'Bob';
        store.data.user.tags.push('tester');
        store.data.counters[0] = 999;
        await nextTick();

        // O modelo original em default_data não deve ter sido alterado
        expect(store.default_data).toEqual({
            user: { name: 'Alice', tags: ['admin', 'dev'] },
            counters: [1, 2, 3]
        });
        expect(store.default_data.user.tags).toEqual(['admin', 'dev']);
        expect(store.default_data.counters[0]).toBe(1);
    });

    it('duas restaurações sucessivas via setDefaultData restabelecem valores íntegros independentes', async () => {
        const store = setupStore(
            { axios: { get: vi.fn(), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref({
                    settings: { theme: 'dark', nested: { active: true } },
                    items: ['a', 'b']
                });
                return { isCached, data };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // 1ª mutação profunda
        store.data.settings.theme = 'light';
        store.data.settings.nested.active = false;
        store.data.items.push('c');
        await nextTick();

        // 1ª restauração
        store.setDefaultData();
        await nextTick();

        expect(store.data).toEqual({
            settings: { theme: 'dark', nested: { active: true } },
            items: ['a', 'b']
        });

        // 2ª mutação profunda após 1ª restauração
        store.data.settings.theme = 'solarized';
        store.data.items[0] = 'z';
        await nextTick();

        // 2ª restauração
        store.setDefaultData();
        await nextTick();

        expect(store.data).toEqual({
            settings: { theme: 'dark', nested: { active: true } },
            items: ['a', 'b']
        });
    });

    it('setDefaultData não dispara autosave / debounce', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { success: true } });
        const store = setupStore(
            { axios: { get: vi.fn(), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref({ count: 10, title: 'Original' });
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        axiosPost.mockClear();

        // Dispara restauração
        store.setDefaultData();
        await nextTick();

        // Avança o tempo do debounce (300ms + margem)
        await vi.advanceTimersByTimeAsync(350);
        await nextTick();

        // Nenhuma requisição POST de autosave deve ser disparada
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('resolução de aliases de default data (default_value, defaultData, etc.)', async () => {
        const storeCamel = setupStore(
            { axios: { get: vi.fn(), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref({ val: 999 });
                const defaultData = { val: 42, meta: { origin: 'alias' } };
                return { isCached, data, defaultData };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        storeCamel.setDefaultData();
        await nextTick();

        expect(storeCamel.data).toEqual({ val: 42, meta: { origin: 'alias' } });

        // Modifica data e garante que defaultData permaneceu inalterado
        storeCamel.data.meta.origin = 'modified';
        expect(storeCamel.defaultData.meta.origin).toBe('alias');
    });

    it('preserva integridade e isolamento após troca de id e desabilitar/reativar store', async () => {
        const store = setupStore(
            { axios: { get: vi.fn(), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const id = ref('item-1');
                const enabled = ref(true);
                const data = ref({ id: 'item-1', details: { note: 'init' } });
                const default_data = { id: 'default', details: { note: 'clean' } };
                return { isCached, id, enabled, data, default_data };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // Troca de id
        store.id = 'item-2';
        store.data.details.note = 'dirty-item-2';
        await nextTick();

        // Desabilita store
        store.enabled = false;
        await nextTick();

        // Reativa store
        store.enabled = true;
        await nextTick();

        // Restaura
        store.setDefaultData();
        await nextTick();

        expect(store.data).toEqual({ id: 'default', details: { note: 'clean' } });
        expect(store.default_data).toEqual({ id: 'default', details: { note: 'clean' } });
    });
});
