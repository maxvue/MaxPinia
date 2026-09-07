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

    it('anexa com separador & quando a url já possui query string preexistente', () => {
        expect(buildUrl('/user?status=active', { page: 2 })).toBe('/user?status=active&page=2');
    });

    it('concatena corretamente com múltiplos query parameters prévios', () => {
        expect(buildUrl('/user?status=active&sort=desc', { page: 2 })).toBe('/user?status=active&sort=desc&page=2');
    });

    it('preserva formatação correta quando a rota base termina com ?', () => {
        expect(buildUrl('/user?', { page: 2 })).toBe('/user?page=2');
    });

    it('preserva formatação correta quando a rota base termina com &', () => {
        expect(buildUrl('/user?status=active&', { page: 2 })).toBe('/user?status=active&page=2');
    });

    it('posiciona o query parameter antes de fragmento #', () => {
        expect(buildUrl('/user#profile', { id: 1 })).toBe('/user?id=1#profile');
    });

    it('posiciona o query parameter antes de fragmento # com query prévia', () => {
        expect(buildUrl('/user?status=active#section', { page: 2 })).toBe('/user?status=active&page=2#section');
    });

    it('retorna a url intacta quando todos os parâmetros forem null ou undefined', () => {
        expect(buildUrl('/user?status=active', { a: null, b: undefined })).toBe('/user?status=active');
    });

    it('suporta URLs absolutas', () => {
        expect(buildUrl('https://api.example.com/items?type=all', { limit: 10 })).toBe('https://api.example.com/items?type=all&limit=10');
    });
});
