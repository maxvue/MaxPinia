import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useAsyncStatus } from '../src';
import type { Status } from '../src/types';

const createMockStatus = (isSuccess = true): Status => ({
    server: {
        get: {
            is_requesting: false,
            is_requesting_now: false,
            is_requested: true,
            is_success: isSuccess,
            is_success_now: isSuccess,
            is_error: !isSuccess,
            error: isSuccess ? null : 'error'
        },
        save: {
            is_requesting: false,
            is_requesting_now: false,
            is_requested: false,
            is_success: false,
            is_success_now: false,
            is_error: false,
            error: null
        }
    },
    cache: {
        get: {
            is_requesting: false,
            is_requesting_now: false,
            is_requested: true,
            is_success: isSuccess,
            is_success_now: isSuccess,
            is_error: !isSuccess,
            error: isSuccess ? null : 'error'
        },
        save: {
            is_requesting: false,
            is_requesting_now: false,
            is_requested: false,
            is_success: false,
            is_success_now: false,
            is_error: false,
            error: null
        }
    }
});

describe('useAsyncStatus', () => {
    let mockDocument: EventTarget;
    const originalDocument = globalThis.document;

    beforeEach(() => {
        mockDocument = new EventTarget();
        vi.stubGlobal('document', mockDocument);
    });

    afterEach(() => {
        if (originalDocument === undefined) {
            vi.unstubAllGlobals();
        } else {
            globalThis.document = originalDocument;
        }
        vi.restoreAllMocks();
    });

    it('Cenário 1: Reatividade e atualização básica quando evento é disparado', () => {
        const asyncStatus = useAsyncStatus();
        expect(asyncStatus.value).toBeNull();

        const mockStatus = createMockStatus(true);
        document.dispatchEvent(new CustomEvent('status-updated', { detail: mockStatus }));

        expect(asyncStatus.value).toEqual(mockStatus);
    });

    it('Cenário 2: Descarte de listener no ciclo de vida (effectScope stop)', () => {
        const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
        let asyncStatusRef: ReturnType<typeof useAsyncStatus> | null = null;

        const scope = effectScope();
        scope.run(() => {
            asyncStatusRef = useAsyncStatus();
        });

        const initialStatus = createMockStatus(true);
        document.dispatchEvent(new CustomEvent('status-updated', { detail: initialStatus }));
        expect(asyncStatusRef!.value).toEqual(initialStatus);

        expect(removeEventListenerSpy).not.toHaveBeenCalled();

        // Finaliza o escopo reativo
        scope.stop();

        // Deve ter removido o listener exatamente 1 vez com a função correta
        expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
        expect(removeEventListenerSpy).toHaveBeenCalledWith('status-updated', expect.any(Function));

        // Novo evento não deve afetar a ref do escopo finalizado
        const nextStatus = createMockStatus(false);
        document.dispatchEvent(new CustomEvent('status-updated', { detail: nextStatus }));

        expect(asyncStatusRef!.value).toEqual(initialStatus);
    });

    it('Cenário 3: Execução segura fora de escopo reativo', () => {
        expect(() => {
            const asyncStatus = useAsyncStatus();
            expect(asyncStatus.value).toBeNull();

            const mockStatus = createMockStatus(true);
            document.dispatchEvent(new CustomEvent('status-updated', { detail: mockStatus }));
            expect(asyncStatus.value).toEqual(mockStatus);
        }).not.toThrow();
    });

    it('Cenário 4: Prevenção de acúmulo em múltiplos ciclos de montagem/desmontagem', () => {
        const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
        const stoppedRefs: ReturnType<typeof useAsyncStatus>[] = [];

        // Simula 5 montagens e desmontagens de componentes/escopos
        for (let i = 0; i < 5; i++) {
            const scope = effectScope();
            let refInstance!: ReturnType<typeof useAsyncStatus>;
            scope.run(() => {
                refInstance = useAsyncStatus();
            });
            stoppedRefs.push(refInstance);
            scope.stop();
        }

        expect(removeEventListenerSpy).toHaveBeenCalledTimes(5);

        // Cria um escopo ativo que permanece vivo
        const activeScope = effectScope();
        let activeRef!: ReturnType<typeof useAsyncStatus>;
        activeScope.run(() => {
            activeRef = useAsyncStatus();
        });

        // Dispara um novo evento
        const updatedStatus = createMockStatus(true);
        document.dispatchEvent(new CustomEvent('status-updated', { detail: updatedStatus }));

        // Apenas o escopo ativo recebe a atualização
        expect(activeRef.value).toEqual(updatedStatus);

        // Os escopos desmontados continuam com o valor null (ou anterior)
        for (const stoppedRef of stoppedRefs) {
            expect(stoppedRef.value).toBeNull();
        }

        activeScope.stop();
        expect(removeEventListenerSpy).toHaveBeenCalledTimes(6);
    });

    it('Cenário 5: Execução segura em ambiente SSR sem document', () => {
        vi.unstubAllGlobals();
        // @ts-expect-error simula ambiente SSR
        delete globalThis.document;

        expect(typeof document).toBe('undefined');

        let asyncStatus!: ReturnType<typeof useAsyncStatus>;
        expect(() => {
            asyncStatus = useAsyncStatus();
        }).not.toThrow();

        expect(asyncStatus.value).toBeNull();
    });

    it('Cenário 6: Produtor e consumidor integrados com store cacheada e emissão de eventos reais', async () => {
        const { createPinia, defineStore, setActivePinia } = await import('pinia');
        const { createMaxPinia } = await import('../src');
        const { ref, createApp, defineComponent, nextTick } = await import('vue');

        const eventsReceived: Status[] = [];
        const eventHandler = (e: Event) => {
            eventsReceived.push((e as CustomEvent<Status>).detail);
        };
        document.addEventListener('status-updated', eventHandler);

        const pinia = createPinia();
        pinia.use(createMaxPinia({ axios: { get: vi.fn(), post: vi.fn() } as any }));
        const app = createApp(defineComponent({ render: () => null }));
        app.use(pinia);
        setActivePinia(pinia);

        const useTestStore = defineStore('test.asyncStatus.store', () => {
            const isCached = ref(true);
            const data = ref({});
            return { isCached, data };
        });

        const store = useTestStore();
        await nextTick();

        // Limpa eventos da inicialização
        eventsReceived.length = 0;

        // Modifica uma flag interna aninhada sem substituir o objeto status
        store.status.server.get.is_requesting = true;
        await nextTick();

        expect(eventsReceived.length).toBeGreaterThan(0);
        expect(eventsReceived[eventsReceived.length - 1].server.get.is_requesting).toBe(true);

        // Modifica a referência de error
        const customError = new Error('Falha simulada');
        store.status.server.get.error = customError;
        store.status.server.get.is_error = true;
        await nextTick();

        expect(eventsReceived[eventsReceived.length - 1].server.get.error).toBe(customError);

        // Executa reset de status
        eventsReceived.length = 0;
        store.status.reset();
        await nextTick();

        expect(eventsReceived.length).toBeGreaterThan(0);
        expect(eventsReceived[eventsReceived.length - 1].server.get.is_error).toBe(false);

        document.removeEventListener('status-updated', eventHandler);
    });
});
