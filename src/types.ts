import type { Ref, ComputedRef } from 'vue';
import type { AxiosInstance } from 'axios';

/** Sub-estado de uma operação (get ou save) contra o servidor ou o cache. */
export interface OperationStatus {
    is_requesting: boolean;
    is_requesting_now: boolean;
    is_requested: boolean;
    is_blank?: boolean;
    is_success: boolean;
    is_success_now: boolean;
    is_error: boolean;
    error: any;
}

/** Estrutura completa de status reativo exposta por cada store cacheada. */
export interface Status {
    server: { get: OperationStatus; save: OperationStatus };
    cache: { get: OperationStatus; save: OperationStatus };
}

/** Opções enviadas ao adapter de loading. */
export interface LoadingOptions {
    key: string;
    target?: string;
    message?: string;
    [k: string]: any;
}

/**
 * Adapter de UI de carregamento. Todos os métodos são opcionais — quando
 * ausentes, o plugin simplesmente não emite feedback de loading.
 */
export interface LoadingAdapter {
    start?: (options: LoadingOptions) => void;
    stop?: (key: string) => void;
    update?: (options: LoadingOptions) => void;
}

/**
 * Configuração injetada no boot via {@link createMaxPinia}.
 * Mantém o pacote desacoplado de qualquer store/serviço específico do app.
 */
export interface MaxPiniaConfig {
    /** Nome do banco localforage. Default: `'pinia'`. */
    cacheName?: string;
    /** Instância axios a usar. Default: o axios global do pacote `axios`. */
    axios?: AxiosInstance;
    /** Retorna o CSRF/session token incluído no header `X-CSRF-TOKEN` dos POSTs. */
    getSessionToken?: () => string | null | undefined;
    /** Indica se o app já inicializou (gate para exibir loading). Default: `() => true`. */
    isAppStarted?: () => boolean;
    /** Adapter de UI de carregamento (opcional). */
    loading?: LoadingAdapter;
    /** Timeout padrão das requisições em ms. Default: `15000`. */
    requestTimeout?: number;
    /**
     * Nome do object store do localforage. Default: `'max-pinia-cache'`.
     * Apps migrando de um plugin anterior podem apontar para o storeName antigo
     * para preservar o cache já existente dos usuários.
     */
    storeName?: string;
    /**
     * Resolve `options.get.route` / `options.save` para uma URL final.
     * Permite usar nomes de rota (ex.: Ziggy) em vez de caminhos literais.
     * Default: trata a rota como URL e anexa `params` como query string.
     */
    resolveRoute?: (route: string, params?: Record<string, any>) => string;
    /** Hook chamado a cada atividade da store (load/save em cache ou servidor). */
    onActivity?: () => void;
}

/** Propriedades injetadas pelo plugin em toda store cacheada. */
declare module 'pinia' {
    export interface PiniaCustomProperties {
        cancelLoad: (retryInSeconds?: number | boolean | null) => void;
        reload: () => void;
        setLoadingMessage: (message: string) => void;
        clearAll: () => Promise<void>;
        saveInServer: () => void;
        saveInCache: () => Promise<void>;
        default_value: any;
        status: Status;
        countChanges: number;
        is_save_in_pause: boolean;
        idx?: any;
        is_done?: boolean;
        is_done_to_show?: ComputedRef<boolean>;
        key?: ComputedRef<string>;
    }
}

export type { Ref };
