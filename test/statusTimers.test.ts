import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, ref, computed, nextTick } from 'vue';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import localforage from 'localforage';
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

function setupStore(config: Parameters<typeof createMaxPinia>[0] = {}, storeOptions: Record<string, any> = {}) {
    const pinia = createPinia();
    pinia.use(createMaxPinia(config));
    const app = createApp(defineComponent({ render: () => null }));
    app.use(pinia);
    setActivePinia(pinia);

    const storeId = storeOptions.id ?? 'test.statusTimers.' + Math.random().toString(36).substring(2, 9);
    const useTestStore = defineStore(storeId, () => {
        const isCached = ref(true);
        const data = ref<Record<string, any>>(storeOptions.data ?? {});
        const enabled = ref(storeOptions.enabled ?? true);
        const id = ref(storeOptions.storeId ?? '1');
        const options = computed(() => (
            storeOptions.options !== undefined
                ? storeOptions.options
                : { get: { route: '/api/items' }, save: '/api/save' }
        ));
        return { isCached, data, enabled, id, options };
    });

    return useTestStore();
}

describe('Auditoria de Timers Transitórios (Issue #7)', () => {
    let mockDocument: EventTarget;
    const originalDocument = (globalThis as any).document;

    beforeEach(() => {
        mockDocument = new EventTarget();
        vi.stubGlobal('document', mockDocument);
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (originalDocument === undefined) {
            vi.unstubAllGlobals();
        } else {
            (globalThis as any).document = originalDocument;
        }
        vi.useRealTimers();
    });

    describe('Cenário 1: Requisições consecutivas/simultâneas dentro da janela de 500ms não sobrescrevem status prematuramente', () => {
        it('mantém is_requesting_now ativo até o término da janela da segunda requisição concorrente', async () => {
            let resolveGet1!: (val: any) => void;
            const promise1 = new Promise((resolve) => { resolveGet1 = resolve; });
            let resolveGet2!: (val: any) => void;
            const promise2 = new Promise((resolve) => { resolveGet2 = resolve; });

            const axiosGet = vi.fn().mockImplementation(() => {
                if (axiosGet.mock.calls.length === 1) return promise1;
                return promise2;
            });

            const store = setupStore(
                { axios: { get: axiosGet, post: vi.fn() } as any },
                { options: { get: { route: '/api/items' } } }
            );

            // 1. Store é inicializada em t = 0ms e dispara a primeira busca via loadInServer()
            // 2. Em t = 10ms, asserção: status.server.get.is_requesting === true e status.server.get.is_requesting_now === true
            await vi.advanceTimersByTimeAsync(10);
            expect(axiosGet).toHaveBeenCalledTimes(1);
            expect(store.status.server.get.is_requesting).toBe(true);
            expect(store.status.server.get.is_requesting_now).toBe(true);

            // 3. Em t = 200ms, dispara-se uma segunda requisição via store.reload()
            await vi.advanceTimersByTimeAsync(190); // t = 200ms
            store.reload();

            // 4. Em t = 210ms, asserção: status.server.get.is_requesting === true e status.server.get.is_requesting_now === true
            await vi.advanceTimersByTimeAsync(10); // t = 210ms
            expect(axiosGet).toHaveBeenCalledTimes(2);
            expect(store.status.server.get.is_requesting).toBe(true);
            expect(store.status.server.get.is_requesting_now).toBe(true);

            // 5. Avançar o tempo em 290ms até t = 500ms (instante em que o timer da requisição 1 expirava no código legado)
            await vi.advanceTimersByTimeAsync(290); // t = 500ms
            // 6. Asserção Red -> Green: status.server.get.is_requesting_now permanece true porque o timer anterior foi cancelado
            expect(store.status.server.get.is_requesting_now).toBe(true);

            // 7. Avançar mais 210ms até t = 710ms (500ms após a segunda requisição disparada em t = 200ms)
            await vi.advanceTimersByTimeAsync(210); // t = 710ms
            // status.server.get.is_requesting_now agora transita para false no momento exato devido à segunda requisição
            expect(store.status.server.get.is_requesting_now).toBe(false);

            // Finaliza as promises pendentes
            resolveGet1({ data: [] });
            resolveGet2({ data: [] });
        });
    });

    describe('Cenário 2: Cancelamento de timers ao descartar a store via store.$dispose() (Memory Leak Prevention)', () => {
        it('cancela timers pendentes e não emite eventos nem muta status após store.$dispose()', async () => {
            const dispatchSpy = vi.spyOn(document, 'dispatchEvent');
            const store = setupStore({}, { options: {} });
            await vi.advanceTimersByTimeAsync(10);

            // 1. Disparar uma operação (status.server.get.is_requesting = true), iniciando um timer de 500ms
            store.status.server.get.is_requesting = true;
            await nextTick();
            expect(store.status.server.get.is_requesting_now).toBe(true);

            // 2. Em t = 100ms, chamar store.$dispose()
            await vi.advanceTimersByTimeAsync(100);
            store.$dispose();

            // 3. Limpar histórico de chamadas do spy
            dispatchSpy.mockClear();

            // 4. Avançar o tempo em 1000ms
            await vi.advanceTimersByTimeAsync(1000);

            // 5. Asserções:
            // Nenhum evento status-updated é disparado no document após o $dispose()
            expect(dispatchSpy).not.toHaveBeenCalled();
            // Nenhuma mutação tardia para false ocorre no objeto status (o callback órfão não executou)
            expect(store.status.server.get.is_requesting_now).toBe(true);

            dispatchSpy.mockRestore();
        });
    });

    describe('Cenário 3: Cancelamento de timers ao desativar a store (store.enabled = false)', () => {
        it('restaura estado inicial via status.reset() e impede disparos órfãos ao desativar a store', async () => {
            const store = setupStore({}, { enabled: true, options: {} });
            await vi.advanceTimersByTimeAsync(10);

            // 1. Disparar requisição em store ativa com timer de 500ms em andamento
            store.status.server.get.is_requesting = true;
            await nextTick();
            expect(store.status.server.get.is_requesting_now).toBe(true);

            await vi.advanceTimersByTimeAsync(100);

            // 2. Alterar store.enabled = false
            store.enabled = false;
            await vi.advanceTimersByTimeAsync(10);

            // 4. Asserção imediata: O estado inicial foi restaurado via status.reset()
            expect(store.status.server.get.is_requesting).toBe(false);
            expect(store.status.server.get.is_requesting_now).toBe(false);

            // 3. Avançar 1000ms
            await vi.advanceTimersByTimeAsync(1000);

            // Nenhum timer pendente executa para mutar status.value após a desativação
            expect(store.status.server.get.is_requesting).toBe(false);
            expect(store.status.server.get.is_requesting_now).toBe(false);
            expect(store.status.server.get.is_success_now).toBe(false);
        });
    });

    describe('Cenário 4: Validação dos canais server.save, cache.get e cache.save', () => {
        it('canal server.save: requisições consecutivas reiniciam o timer de 500ms sem sobrescrita prematura', async () => {
            let resolvePost1!: (val: any) => void;
            const promise1 = new Promise((resolve) => { resolvePost1 = resolve; });
            let resolvePost2!: (val: any) => void;
            const promise2 = new Promise((resolve) => { resolvePost2 = resolve; });

            const axiosPost = vi.fn().mockImplementation(() => {
                if (axiosPost.mock.calls.length === 1) return promise1;
                return promise2;
            });

            const store = setupStore(
                { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
                { data: { count: 1 }, options: { save: '/api/save' } }
            );

            await vi.advanceTimersByTimeAsync(10);

            // 1ª chamada saveInServer em t = 0ms
            store.saveInServer();
            await vi.advanceTimersByTimeAsync(10); // t = 10ms
            expect(axiosPost).toHaveBeenCalledTimes(1);
            expect(store.status.server.save.is_requesting).toBe(true);
            expect(store.status.server.save.is_requesting_now).toBe(true);

            // 2ª chamada saveInServer em t = 200ms
            await vi.advanceTimersByTimeAsync(190); // t = 200ms
            store.saveInServer();
            await vi.advanceTimersByTimeAsync(10); // t = 210ms
            expect(axiosPost).toHaveBeenCalledTimes(2);
            expect(store.status.server.save.is_requesting).toBe(true);
            expect(store.status.server.save.is_requesting_now).toBe(true);

            // Em t = 500ms: timer da 1ª chamada foi cancelado, status permanece true
            await vi.advanceTimersByTimeAsync(290); // t = 500ms
            expect(store.status.server.save.is_requesting_now).toBe(true);

            // Em t = 710ms: timer da 2ª chamada expira
            await vi.advanceTimersByTimeAsync(210); // t = 710ms
            expect(store.status.server.save.is_requesting_now).toBe(false);

            resolvePost1({ data: {} });
            resolvePost2({ data: {} });
        });

        it('canal cache.save: operações consecutivas reiniciam o timer de 500ms sem sobrescrita prematura', async () => {
            let resolveItem1!: (val: any) => void;
            const promiseItem1 = new Promise((resolve) => { resolveItem1 = resolve; });
            let resolveItem2!: (val: any) => void;
            const promiseItem2 = new Promise((resolve) => { resolveItem2 = resolve; });

            let setItemCalls = 0;
            vi.mocked(localforage.setItem).mockImplementation(() => {
                setItemCalls++;
                return (setItemCalls === 1 ? promiseItem1 : promiseItem2) as any;
            });

            const store = setupStore(
                { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn() } as any },
                { data: { title: 'draft' }, options: {} }
            );

            await vi.advanceTimersByTimeAsync(10);
            setItemCalls = 0;

            // 1ª gravação em cache em t = 0ms
            store.saveInCache();
            await nextTick();
            expect(store.status.cache.save.is_requesting).toBe(true);
            expect(store.status.cache.save.is_requesting_now).toBe(true);

            // 2ª gravação em cache em t = 200ms
            await vi.advanceTimersByTimeAsync(200); // t = 200ms
            store.saveInCache();
            await nextTick();
            expect(store.status.cache.save.is_requesting).toBe(true);
            expect(store.status.cache.save.is_requesting_now).toBe(true);

            // Em t = 500ms: timer da 1ª gravação foi cancelado, status permanece true
            await vi.advanceTimersByTimeAsync(300); // t = 500ms
            expect(store.status.cache.save.is_requesting_now).toBe(true);

            // Em t = 710ms: timer da 2ª gravação expira
            await vi.advanceTimersByTimeAsync(210); // t = 710ms
            expect(store.status.cache.save.is_requesting_now).toBe(false);

            resolveItem1(null);
            resolveItem2(null);
        });

        it('canal cache.get: transições consecutivas reiniciam o timer de 500ms sem sobrescrita prematura', async () => {
            const store = setupStore({}, { options: {} });
            await vi.advanceTimersByTimeAsync(10);

            // 1ª transição em t = 0ms: cache.get inicia busca
            store.status.cache.get.is_requesting = true;
            await nextTick();
            expect(store.status.cache.get.is_requesting_now).toBe(true);

            // 2ª transição em t = 200ms: cache.get conclui com sucesso
            await vi.advanceTimersByTimeAsync(200); // t = 200ms
            store.status.cache.get.is_requesting = false;
            store.status.cache.get.is_success = true;
            await nextTick();
            expect(store.status.cache.get.is_success_now).toBe(true);

            // Em t = 500ms: timer de t = 0ms (que expiraria aos 500ms) foi cancelado;
            // is_success_now permanece true pois o novo timer foi agendado em t = 200ms
            await vi.advanceTimersByTimeAsync(300); // t = 500ms
            expect(store.status.cache.get.is_success_now).toBe(true);

            // Em t = 710ms: timer de t = 200ms expira
            await vi.advanceTimersByTimeAsync(210); // t = 710ms
            expect(store.status.cache.get.is_success_now).toBe(false);
        });
    });

    describe('Cenário 5: Transição para false/false não agenda novo timer', () => {
        it('não agenda setTimeout de 500ms quando is_requesting e is_success forem ambos false', async () => {
            const store = setupStore({}, { options: {} });
            await vi.advanceTimersByTimeAsync(10);

            // Ativa uma requisição primeiro
            store.status.server.get.is_requesting = true;
            await nextTick();
            expect(store.status.server.get.is_requesting_now).toBe(true);

            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

            // Simula erro na operação (is_requesting = false, is_success = false)
            store.status.server.get.is_requesting = false;
            store.status.server.get.is_success = false;
            await nextTick();

            // Asserção: nenhum novo temporizador com delay de 500ms é agendado no event loop
            const timerCalls500 = setTimeoutSpy.mock.calls.filter((call) => call[1] === 500);
            expect(timerCalls500.length).toBe(0);

            expect(store.status.server.get.is_requesting_now).toBe(false);
            expect(store.status.server.get.is_success_now).toBe(false);

            setTimeoutSpy.mockRestore();
        });
    });
});
