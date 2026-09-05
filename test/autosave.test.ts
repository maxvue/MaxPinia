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
    return defineStore(`test.autosave.${storeCounter}`, storeSetup)();
}

describe('Pipeline de Auto-Save Reativo', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('Caso 1: Auto-save reativo com debounce de 300ms', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { success: true } });
        const axiosGet = vi.fn().mockResolvedValue({ data: {} });

        const store = setupStore(
            { axios: { get: axiosGet, post: axiosPost } as any, requestTimeout: 5000 },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ field: 'inicial', count: 0 });
                const options = computed(() => ({ save: '/api/items/save' }));
                return { isCached, data, options };
            }
        );

        // Avança 10ms para permitir que o timeout de unpause (resumeSave) de 1ms execute
        await vi.advanceTimersByTimeAsync(10);
        expect(axiosPost).not.toHaveBeenCalled();

        // 1ª mutação
        store.data.field = 'valor1';
        await nextTick();

        // Avança 150ms: o debounce é de 300ms, então NÃO deve ter sido chamado ainda
        await vi.advanceTimersByTimeAsync(150);
        expect(axiosPost).not.toHaveBeenCalled();

        // 2ª mutação antes do término do debounce (reinicia a contagem de 300ms)
        store.data.field = 'valor2';
        await nextTick();

        // Avança 200ms (total de 350ms desde a 1ª, mas apenas 200ms desde a 2ª)
        await vi.advanceTimersByTimeAsync(200);
        expect(axiosPost).not.toHaveBeenCalled();

        // Avança mais 100ms (completando os 300ms desde a 2ª mutação)
        await vi.advanceTimersByTimeAsync(100);
        await nextTick();

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost).toHaveBeenCalledWith(
            '/api/items/save',
            { field: 'valor2', count: 0 },
            expect.objectContaining({
                timeout: 5000,
                headers: expect.objectContaining({
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                }),
                withCredentials: true
            })
        );
    });

    it('Caso 1.2: Múltiplas mutações rápidas colapsam em um único envio com o estado final', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { success: true } });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ step: 0 });
                const options = computed(() => ({ save: '/api/step' }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        store.data.step = 1;
        await nextTick();
        await vi.advanceTimersByTimeAsync(50);

        store.data.step = 2;
        await nextTick();
        await vi.advanceTimersByTimeAsync(50);

        store.data.step = 3;
        await nextTick();

        await vi.advanceTimersByTimeAsync(300);
        await nextTick();

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost).toHaveBeenCalledWith('/api/step', { step: 3 }, expect.anything());
    });

    it('Caso 2: Bloqueio de salvamento por flags (block_save, no_save, noSave, blockSave, isList, is_list)', async () => {
        const flags = ['block_save', 'no_save', 'noSave', 'blockSave', 'isList', 'is_list'] as const;

        for (const flag of flags) {
            const axiosPost = vi.fn().mockResolvedValue({ data: {} });
            const store = setupStore(
                { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
                () => {
                    const isCached = ref(true);
                    const data = ref<Record<string, any>>({ title: 'titulo_base' });
                    const options = computed(() => ({ save: '/api/save' }));
                    const flagRef = ref(true);
                    return { isCached, data, options, [flag]: flagRef };
                }
            );

            await vi.advanceTimersByTimeAsync(10);

            store.data.title = `modificado_com_${flag}`;
            await nextTick();
            await vi.advanceTimersByTimeAsync(400);

            expect(axiosPost).not.toHaveBeenCalled();
        }
    });

    it('Caso 2.1: Proteção contra dados inalterados ou vazios', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ name: 'mesmo_valor' });
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // Reatribuir com valor idêntico
        store.data.name = 'mesmo_valor';
        await nextTick();
        await vi.advanceTimersByTimeAsync(400);
        expect(axiosPost).not.toHaveBeenCalled();

        // Atribuir objeto vazio
        store.data = {};
        await nextTick();
        await vi.advanceTimersByTimeAsync(400);
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('Caso 2.2: Não executa salvamento se a store estiver desabilitada (enabled === false)', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const enabled = ref(false);
                const data = ref<Record<string, any>>({ name: 'teste' });
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, enabled, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        store.data.name = 'alterado';
        await nextTick();
        await vi.advanceTimersByTimeAsync(400);
        expect(axiosPost).not.toHaveBeenCalled();

        // Também valida chamada direta a saveInServer
        await store.saveInServer();
        expect(axiosPost).not.toHaveBeenCalled();
    });

    it('Caso 3: Remoção de chaves via removeToSave e remove_to_save', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({
                    name: 'Teste Sanitizado',
                    tempToken: 'secret_123',
                    nested: { internal: true, keep: 42 }
                });
                const removeToSave = ['tempToken', 'nested.internal'];
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, removeToSave, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        await store.saveInServer();
        expect(axiosPost).toHaveBeenCalledTimes(1);

        const sentPayload = axiosPost.mock.calls[0][1];
        expect(sentPayload).toEqual({
            name: 'Teste Sanitizado',
            nested: { keep: 42 }
        });
        expect(sentPayload).not.toHaveProperty('tempToken');
        expect(sentPayload.nested).not.toHaveProperty('internal');
    });

    it('Caso 3.1: Suporte a remove_to_save em snake_case', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({
                    title: 'Artigo',
                    author_id: 99,
                    _cache_timestamp: 123456
                });
                const remove_to_save = ['_cache_timestamp'];
                const options = computed(() => ({ save: '/api/articles' }));
                return { isCached, data, remove_to_save, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();

        const sentPayload = axiosPost.mock.calls[0][1];
        expect(sentPayload).toEqual({
            title: 'Artigo',
            author_id: 99
        });
        expect(sentPayload).not.toHaveProperty('_cache_timestamp');
    });

    it('Caso 4: Tratamento de save_return === true atualiza store.data sem loop recursivo', async () => {
        const axiosPost = vi.fn().mockResolvedValue({
            data: { id: 10, name: 'Atualizado do Servidor', extra: 'gerado_no_backend' }
        });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ id: 10, name: 'Nome Local' });
                const save_return = ref(true);
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, save_return, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);

        // Aciona saveInServer
        await store.saveInServer();

        // store.data deve ter sido atualizado com a resposta do servidor
        expect(store.data).toEqual({
            id: 10,
            name: 'Atualizado do Servidor',
            extra: 'gerado_no_backend'
        });

        // Avança o tempo para garantir que a atualização da resposta NÃO disparou novo auto-save
        await vi.advanceTimersByTimeAsync(500);
        await nextTick();

        expect(axiosPost).toHaveBeenCalledTimes(1);
    });

    it('Caso 4.1: Tratamento de save_return com response.data.original', async () => {
        const axiosPost = vi.fn().mockResolvedValue({
            data: { original: { id: 7, name: 'Original unwrapped' } }
        });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ id: 7, name: 'Local' });
                const save_return = ref(true);
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, save_return, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();

        expect(store.data).toEqual({ id: 7, name: 'Original unwrapped' });
    });

    it('Caso 4.2: Tratamento de save_return como string (chave específica divergente)', async () => {
        const axiosPost = vi.fn().mockResolvedValue({
            data: { id: 200, name: 'Novo Registro Criado' }
        });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ id: null, name: 'Rascunho' });
                const save_return = ref('id');
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, save_return, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();

        // id divergia (null !== 200), então store.data foi atualizado
        expect(store.data).toEqual({ id: 200, name: 'Novo Registro Criado' });
    });

    it('Caso 4.3: Tratamento de save_return como string (chave idêntica NÃO sobrescreve)', async () => {
        const axiosPost = vi.fn().mockResolvedValue({
            data: { id: 100, name: 'Resposta Ignorada' }
        });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ id: 100, name: 'Nome Mantido' });
                const save_return = ref('id');
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, save_return, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();

        // id era igual (100 === 100), então store.data permaneceu inalterado
        expect(store.data).toEqual({ id: 100, name: 'Nome Mantido' });
    });

    it('Caso 5: Recarga automática via reload_after_save e reload_after_save_default', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { ok: true } });
        const axiosGet = vi.fn().mockResolvedValue({ data: { id: 1, name: 'Recarregado do GET' } });

        const store = setupStore(
            { axios: { get: axiosGet, post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ id: 1, name: 'Salvo' });
                const reload_after_save = ref(true);
                const reload_after_save_default = ref(true);
                const options = computed(() => ({
                    get: { route: '/api/items/1' },
                    save: '/api/items/save'
                }));
                return { isCached, data, reload_after_save, reload_after_save_default, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        axiosGet.mockClear();

        await store.saveInServer();
        expect(axiosPost).toHaveBeenCalledTimes(1);

        // Como reload_after_save estava true, loadInServer() deve ter sido disparado
        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledWith('/api/items/1', expect.anything()));
        expect(store.reload_after_save).toBe(true);
    });

    it('Caso 6: getSaveData customizado prevalece sobre store.data', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: {} });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ raw: 123 });
                const getSaveData = () => ({ transformed: 123, meta: 'custom' });
                const options = computed(() => ({ save: '/api/custom-save' }));
                return { isCached, data, getSaveData, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();

        expect(axiosPost).toHaveBeenCalledWith(
            '/api/custom-save',
            { transformed: 123, meta: 'custom' },
            expect.anything()
        );
    });

    it('Caso 7: Tratamento de erro na requisição de salvamento atualiza o status', async () => {
        const saveError = new Error('Falha 500 Internal Server Error');
        const axiosPost = vi.fn().mockRejectedValue(saveError);
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ field: 'teste' });
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();
        await vi.waitFor(() => expect(store.status.server.save.is_requested).toBe(true));

        expect(store.status.server.save.is_success).toBe(false);
        expect(store.status.server.save.is_error).toBe(true);
        expect(store.status.server.save.error).toBe(saveError);
        expect(store.status.server.save.is_requesting).toBe(false);
    });

    it('Caso 8: Callback onDownloadProgress atualiza o progresso', async () => {
        let capturedConfig: any;
        const axiosPost = vi.fn().mockImplementation((_url, _data, cfg) => {
            capturedConfig = cfg;
            return Promise.resolve({ data: { ok: true } });
        });
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ field: 'teste' });
                const options = computed(() => ({ save: '/api/save' }));
                return { isCached, data, options };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInServer();

        expect(capturedConfig).toBeDefined();
        expect(typeof capturedConfig.onDownloadProgress).toBe('function');
        capturedConfig.onDownloadProgress({ loaded: 50, total: 100 });
    });

    it('Caso 9: saveInCache com store.enabled === false restaura o default data', async () => {
        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const enabled = ref(true);
                const data = ref<Record<string, any>>({ initialKey: 'padrao' });
                return { isCached, enabled, data };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        expect(store.data).toEqual({ initialKey: 'padrao' });

        // Modifica os dados e desabilita a store
        store.data = { field: 'modificado' };
        store.enabled = false;

        await store.saveInCache();

        // Deve restaurar os dados padrão
        expect(store.data).toEqual({ initialKey: 'padrao' });
    });

    it('Caso 10: saveInCache trata erro de escrita do localforage', async () => {
        const localforage = (await import('localforage')).default;
        vi.spyOn(localforage, 'setItem').mockRejectedValueOnce(new Error('QuotaExceeded'));

        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ field: 'valor' });
                return { isCached, data };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        await store.saveInCache();
        await vi.waitFor(() => expect(store.status.cache.save.is_requested).toBe(true));

        expect(store.status.cache.save.is_success).toBe(false);
        expect(store.status.cache.save.is_error).toBe(true);
    });

    it('Caso 11: includeInCacheValues observa propriedades extras e salva em cache', async () => {
        const localforage = (await import('localforage')).default;
        const setItemSpy = vi.spyOn(localforage, 'setItem').mockResolvedValue(null as any);

        const store = setupStore(
            { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
            () => {
                const isCached = ref(true);
                const data = ref<Record<string, any>>({ name: 'store' });
                const extraFilter = ref('active');
                const inCache = ['extraFilter'];
                return { isCached, data, extraFilter, inCache };
            }
        );

        await vi.advanceTimersByTimeAsync(10);
        setItemSpy.mockClear();

        store.extraFilter = 'archived';
        await nextTick();
        await vi.advanceTimersByTimeAsync(10);

        expect(setItemSpy).toHaveBeenCalled();
    });

    it('Caso 12: useAsyncStatus e evento customizado status-updated', async () => {
        const { useAsyncStatus } = await import('../src');

        // Simula ambiente com document
        const listeners: Record<string, ((e: any) => void)[]> = {};
        const mockDoc = {
            addEventListener: (event: string, fn: any) => {
                listeners[event] = listeners[event] || [];
                listeners[event].push(fn);
            },
            dispatchEvent: (event: any) => {
                if (listeners[event.type]) {
                    for (const fn of listeners[event.type]) fn(event);
                }
            }
        };

        const originalDoc = (globalThis as any).document;
        (globalThis as any).document = mockDoc;

        try {
            const statusRef = useAsyncStatus();
            expect(statusRef.value).toBeNull();

            // Dispara evento customizado
            mockDoc.dispatchEvent({
                type: 'status-updated',
                detail: { server: { get: { is_success: true } } }
            });

            expect(statusRef.value).toEqual({ server: { get: { is_success: true } } });
        } finally {
            (globalThis as any).document = originalDoc;
        }
    });
});
