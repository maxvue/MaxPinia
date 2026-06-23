import { ref, watch, nextTick, type Ref, type WatchSource, type WatchHandle } from 'vue';
import { ulid } from 'ulid';
import { watchDebounced } from '@vueuse/core';
import { get, camelCase, kebabCase, snakeCase } from 'lodash-es';

/**
 * Ref com método `reset()` que restaura o valor inicial.
 * Inline de `@maxvue/max-use` para manter o pacote sem dependências de framework.
 */
export type DefaultReset<T> = Ref<T> & { reset(): void; initialData?: any; timer?: number | null };

export function useDefaultReset<T>(initialData: T, timer: number | null = null): DefaultReset<T> {
    const state = ref<T>() as DefaultReset<T>;
    state.initialData = JSON.parse(JSON.stringify(initialData));

    state.reset = () => {
        const new_data = JSON.parse(JSON.stringify(state.initialData));
        if (typeof state.initialData === 'object' && state.initialData) {
            if ((state.initialData as any)?.id === 'ulid') (new_data as any).id = ulid().toLowerCase();
            if ((state.initialData as any)?.created_at === 'now') (new_data as any).created_at = new Date().toISOString();
        }
        state.value = new_data;
    };

    state.reset();
    state.timer = timer;
    if (timer) watchDebounced(state, () => state.reset(), { debounce: timer });

    return state;
}

/** Verdadeiro quando o valor não é null/undefined/string vazia/array ou objeto vazio. */
export function isNotEmpty(value: any): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

/** Watch que só dispara o callback quando o valor é válido (não-vazio). */
export function watchValid<T>(
    source: WatchSource<T>,
    callback: (value: NonNullable<T>, oldValue: T | undefined) => void,
    options?: { once?: boolean; immediate?: boolean; deep?: boolean }
): WatchHandle {
    const handle = watch(source, (value, oldValue) => {
        if (!isNotEmpty(value)) return;
        if (options?.once) nextTick(() => handle.stop());
        callback(value as NonNullable<T>, oldValue);
    }, { ...options, once: false } as any);
    return handle;
}

/**
 * Resolve o primeiro caminho não-nulo dentre variações camelCase/kebab/snake.
 * Suporta paths aninhados (`'options.get.route'`).
 */
export function getIn(location: any, names: string[]): any {
    for (const name of names) {
        const camel = name.split('.').map((part) => camelCase(part)).join('.');
        const kebab = name.split('.').map((part) => kebabCase(part)).join('.');
        const snake = name.split('.').map((part) => snakeCase(part)).join('.');
        const result: any = get(location, camel, null) ?? get(location, kebab, null) ?? get(location, snake, null);
        if (result) return result.value ?? result;
    }
    return null;
}

/** Verdadeiro se algum dos caminhos (em qualquer casing) for explicitamente `false`. */
export function anyIsFalseIn(location: any, names: string[]): boolean {
    for (const name of names) {
        const camel = name.split('.').map((part) => camelCase(part)).join('.');
        const kebab = name.split('.').map((part) => kebabCase(part)).join('.');
        const snake = name.split('.').map((part) => snakeCase(part)).join('.');
        const result: any = get(location, camel, null) ?? get(location, kebab, null) ?? get(location, snake, null);
        if (result === false) return true;
    }
    return false;
}
