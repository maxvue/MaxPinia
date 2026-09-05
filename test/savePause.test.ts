import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, defineComponent, ref, computed, nextTick } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import { createMaxPinia } from '../src';
import localforage from 'localforage';

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

function setup(config: Parameters<typeof createMaxPinia>[0] = {}, storeSetup: () => any = () => ({})) {
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);
    return defineStore('test.savePause.' + Math.random().toString(36).substring(7), storeSetup)();
}

describe('savePause & is_save_in_pause determinism (Issue #2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('Teste 1: Mutação logo após inicialização / microtask incrementa countChanges', async () => {
        const store = setup({}, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ title: 'Inicial' });
            return { isCached, data };
        });

        // Aguarda a inicialização síncrona/microtask completar
        await nextTick();

        // Verifica se a pausa de salvamento foi desativada deterministicamente
        expect(store.is_save_in_pause).toBe(false);

        // Realiza a mutação do consumidor
        store.data.title = 'Novo Titulo';
        await nextTick();

        // O watcher deve detectar a alteração e incrementar countChanges
        expect(store.countChanges).toBe(1);
    });

    it('Teste 2: Mutação logo após loadInServer incrementa countChanges', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { field: 'valor_servidor' } });
        const store = setup({ axios: { get: axiosGet, post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({});
            const options = computed(() => ({ get: { route: '/api/resource' } }));
            return { isCached, data, options };
        });

        // Aguarda resolução de loadInServer acionado na inicialização ou manualmente
        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
        await nextTick();

        expect(store.data).toEqual({ field: 'valor_servidor' });
        expect(store.countChanges).toBe(0);
        expect(store.is_save_in_pause).toBe(false);

        // Mutação imediata do consumidor após carregamento do servidor
        store.data.field = 'alterado';
        await nextTick();

        expect(store.countChanges).toBe(1);
    });

    it('Teste 3: Imunidade a falsos positivos durante carga interna (loadInServer não incrementa countChanges)', async () => {
        const axiosGet = vi.fn().mockResolvedValue({ data: { user: 'Max' } });
        const store = setup({ axios: { get: axiosGet, post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({});
            const options = computed(() => ({ get: { route: '/api/user' } }));
            return { isCached, data, options };
        });

        await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
        await nextTick();

        expect(store.data).toEqual({ user: 'Max' });
        // Carga interna não deve contar como alteração do usuário
        expect(store.countChanges).toBe(0);
    });

    it('Teste 4: Reentrância e aninhamento de pauseSave / resumeSave com pauseDepth', async () => {
        const store = setup({}, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ count: 0 });
            return { isCached, data };
        });

        await nextTick();
        expect(store.is_save_in_pause).toBe(false);

        // Invoca pauseSave duas vezes
        store.pauseSave();
        store.pauseSave();
        expect(store.is_save_in_pause).toBe(true);

        // Primeiro resumeSave não deve despausar pois depth ainda é 1
        store.resumeSave();
        await nextTick();
        expect(store.is_save_in_pause).toBe(true);

        // Segundo resumeSave deve despausar após nextTick
        store.resumeSave();
        await nextTick();
        expect(store.is_save_in_pause).toBe(false);
    });

    it('Teste 5: Mutação após loadInCache não dispara countChanges indevido e aceita mutação subsequente', async () => {
        vi.mocked(localforage.getItem).mockResolvedValueOnce({ data: { cachedKey: 'cachedVal' } });

        const store = setup({ axios: { get: vi.fn().mockReturnValue(new Promise(() => {})), post: vi.fn() } as any }, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({});
            const options = computed(() => ({ get: { route: '/api/cached' } }));
            return { isCached, data, options };
        });

        await vi.waitFor(() => expect(localforage.getItem).toHaveBeenCalled());
        await nextTick();

        expect(store.data).toEqual({ cachedKey: 'cachedVal' });
        expect(store.countChanges).toBe(0);
        expect(store.is_save_in_pause).toBe(false);

        // Mutação do usuário após o cache ter carregado
        store.data.cachedKey = 'userUpdated';
        await nextTick();
        expect(store.countChanges).toBe(1);
    });

    it('Teste 6: Determinismo sob vi.useFakeTimers sem necessidade de advanceTimers', async () => {
        vi.useFakeTimers();

        const store = setup({}, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ item: 'inicial' });
            return { isCached, data };
        });

        // Com nextTick (microtask), não precisamos avançar timers de sistema
        await nextTick();
        expect(store.is_save_in_pause).toBe(false);

        store.data.item = 'modificado';
        await nextTick();
        expect(store.countChanges).toBe(1);

        vi.useRealTimers();
    });

    it('Teste 7: Mutação em save_return não dispara novo incremento', async () => {
        const axiosPost = vi.fn().mockResolvedValue({ data: { id: 10, name: 'Criado no Servidor' } });
        const store = setup({ axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any }, () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ name: 'Meu Nome' });
            const save_return = ref(true);
            const options = computed(() => ({ save: '/api/save' }));
            return { isCached, data, save_return, options };
        });

        await nextTick();
        expect(store.is_save_in_pause).toBe(false);

        store.saveInServer();
        await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());
        await nextTick();

        // Dados foram atualizados com o retorno do servidor sem gerar loop
        expect(store.data).toEqual({ id: 10, name: 'Criado no Servidor' });
        expect(store.countChanges).toBe(0);
        expect(store.is_save_in_pause).toBe(false);

        // Próxima alteração do usuário é detectada normalmente
        store.data.name = 'Nome Editado Pelo Usuário';
        await nextTick();
        expect(store.countChanges).toBe(1);
    });
});
