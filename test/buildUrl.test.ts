import { describe, it, expect } from 'vitest';
import { buildUrl } from '../src/plugin';

describe('buildUrl', () => {
    it('retorna a url intacta sem params', () => {
        expect(buildUrl('/user')).toBe('/user');
        expect(buildUrl('/user', {})).toBe('/user');
    });

    it('anexa params como query string', () => {
        expect(buildUrl('/user', { id: 1, name: 'ana' })).toBe('/user?id=1&name=ana');
    });

    it('ignora valores null e undefined', () => {
        expect(buildUrl('/user', { a: 1, b: null, c: undefined })).toBe('/user?a=1');
    });

    it('mantém valores falsy válidos (0, false, string vazia)', () => {
        expect(buildUrl('/user', { a: 0, b: false, c: '' })).toBe('/user?a=0&b=false&c=');
    });
});
