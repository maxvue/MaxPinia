import { type Ref, type WatchSource, type WatchHandle } from 'vue';
/**
 * Ref com método `reset()` que restaura o valor inicial.
 * Inline de `@maxvue/max-use` para manter o pacote sem dependências de framework.
 */
export type DefaultReset<T> = Ref<T> & {
    reset(): void;
    initialData?: any;
    timer?: number | null;
};
export declare function useDefaultReset<T>(initialData: T, timer?: number | null): DefaultReset<T>;
/** Verdadeiro quando o valor não é null/undefined/string vazia/array ou objeto vazio. */
export declare function isNotEmpty(value: any): boolean;
/** Watch que só dispara o callback quando o valor é válido (não-vazio). */
export declare function watchValid<T>(source: WatchSource<T>, callback: (value: NonNullable<T>, oldValue: T | undefined) => void, options?: {
    once?: boolean;
    immediate?: boolean;
    deep?: boolean;
}): WatchHandle;
/**
 * Resolve o primeiro caminho não-nulo dentre variações camelCase/kebab/snake.
 * Suporta paths aninhados (`'options.get.route'`).
 */
export declare function getIn(location: any, names: string[]): any;
/** Verdadeiro se algum dos caminhos (em qualquer casing) for explicitamente `false`. */
export declare function anyIsFalseIn(location: any, names: string[]): boolean;
//# sourceMappingURL=internal.d.ts.map