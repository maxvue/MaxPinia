import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import {
    isNotEmpty,
    getIn,
    anyIsFalseIn,
    useDefaultReset
} from '../src/helpers/internal';

describe('isNotEmpty', () => {
    it('trata null/undefined como vazio', () => {
        expect(isNotEmpty(null)).toBe(false);
        expect(isNotEmpty(undefined)).toBe(false);
    });

    it('trata strings em branco como vazio', () => {
        expect(isNotEmpty('')).toBe(false);
        expect(isNotEmpty('   ')).toBe(false);
        expect(isNotEmpty('x')).toBe(true);
    });

    it('trata arrays e objetos vazios como vazio', () => {
        expect(isNotEmpty([])).toBe(false);
        expect(isNotEmpty({})).toBe(false);
        expect(isNotEmpty([1])).toBe(true);
        expect(isNotEmpty({ a: 1 })).toBe(true);
    });

    it('considera 0 e false como não-vazios (primitivos)', () => {
        expect(isNotEmpty(0)).toBe(true);
        expect(isNotEmpty(false)).toBe(true);
    });
});

describe('getIn', () => {
    it('resolve o primeiro caminho existente', () => {
        const src = { options: { get: { route: '/user' } } };
        expect(getIn(src, ['options.get.route'])).toBe('/user');
    });

    it('resolve variações de casing (snake/kebab/camel)', () => {
        const snake = { options: { get_route: '/a' } };
        expect(getIn(snake, ['options.getRoute'])).toBe('/a');

        const camel = { options: { getRoute: '/b' } };
        expect(getIn(camel, ['options.get_route'])).toBe('/b');
    });

    it('desembrulha refs', () => {
        const src = { route: ref('/from-ref') };
        expect(getIn(src, ['route'])).toBe('/from-ref');
    });

    it('retorna null quando nenhum caminho casa', () => {
        expect(getIn({}, ['a', 'b.c'])).toBeNull();
    });
});

describe('anyIsFalseIn', () => {
    it('detecta false explícito em qualquer casing', () => {
        expect(anyIsFalseIn({ options: { enabled: false } }, ['options.enabled'])).toBe(true);
        expect(anyIsFalseIn({ is_enabled: false }, ['isEnabled'])).toBe(true);
    });

    it('ignora ausência e valores truthy', () => {
        expect(anyIsFalseIn({}, ['enabled'])).toBe(false);
        expect(anyIsFalseIn({ enabled: true }, ['enabled'])).toBe(false);
    });
});

describe('useDefaultReset', () => {
    it('inicializa com uma cópia do valor', () => {
        const state = useDefaultReset({ a: 1 });
        expect(state.value).toEqual({ a: 1 });
    });

    it('reset() restaura o valor inicial mesmo após mutação', () => {
        const state = useDefaultReset({ a: 1 });
        state.value = { a: 999 } as any;
        state.reset();
        expect(state.value).toEqual({ a: 1 });
    });

    it('não compartilha referência com o initialData', () => {
        const state = useDefaultReset({ nested: { x: 1 } });
        (state.value as any).nested.x = 2;
        state.reset();
        expect((state.value as any).nested.x).toBe(1);
    });

    it('gera novo ulid quando id === "ulid"', () => {
        const state = useDefaultReset<{ id: string }>({ id: 'ulid' });
        const first = state.value.id;
        state.reset();
        const second = state.value.id;
        expect(first).not.toBe('ulid');
        expect(second).not.toBe('ulid');
        expect(first).not.toBe(second);
    });
});
