# Plano de Implementação - Issue #9

## Descrição e Causa Raiz

### Problema Relatado e Agravantes
Durante a auditoria automatizada (Lente 9 — Testes: ausência, falha e incorreção), identificou-se um defeito estrutural na função utilitária `buildUrl` em [`src/plugin.ts:12-18`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts#L12-L18). A função concatena parâmetros de busca utilizando invariavelmente o delimitador de início de query string `?`:
```ts
return str ? `${url}?${str}` : url;
```
Quando a rota configurada no store já contém query parameters preexistentes (por exemplo, `/api/items?status=active` ou rotas de API com filtros padrão), a chamada `buildUrl('/api/items?status=active', { page: 2 })` produz `/api/items?status=active?page=2`.

**Agravantes:**
1. **Violação da RFC 3986 (Uniform Resource Identifier - Generic Syntax):**
   Conforme a Seção 3 da RFC 3986, uma URI é composta por `path [ "?" query ] [ "#" fragment ]`. O caractere `?` delimita unicamente o início do componente de query. A presença de múltiplos caracteres `?` não codificados gera uma URI malformada e ambígua.
2. **Corrupção de Parâmetros e Falhas de Parsing em Frameworks Backend:**
   Servidores e roteadores HTTP backend (Express, Fastify, Laravel, Django, Spring Boot, ASP.NET, Go `net/url`) dividem a URI no primeiro `?` e assumem que todos os parâmetros subsequentes são separados exclusivamente por `&`. Diante de `?status=active?page=2`:
   - O primeiro parâmetro (`status`) tem seu valor corrompido para o literal `"active?page=2"`.
   - O segundo parâmetro (`page`) é descaracterizado como chave, sendo descartado ou ignorado.
   Isso acarreta consultas corrompidas no banco de dados, quebra silenciosa de paginações e ordenações, ou respostas de erro HTTP 400 (Bad Request) / 422 (Unprocessable Entity).
3. **Má Formação em URLs com Delimitadores Pontuais (`?` ou `&` terminais):**
   Se a rota base já terminar com `?` (ex.: `/api/items?`), a implementação atual produz `/api/items??page=2`. Se terminar com `&` (ex.: `/api/items?status=active&`), produz `/api/items?status=active&?page=2`.
4. **Deslocamento e Omissão com Fragmentos de Hash (`#`):**
   Caso a URL contenha um fragmento (ex.: `/user#section`), concatenar cegamente ao final da string produz `/user#section?page=2`. Na semântica de URIs, o ponto de interrogação passa a ser tratado como parte do fragmento do cliente, e o parâmetro `page` sequer é enviado ao servidor HTTP.
5. **Omissão Crítica na Suíte de Testes Existente (`test/buildUrl.test.ts`):**
   O arquivo [`test/buildUrl.test.ts:1-21`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/test/buildUrl.test.ts#L1-L21) possui apenas 4 asserções, todas testando unicamente a rota estática simples `/user`. A suíte nunca contemplou URLs com query strings preexistentes, delimitadores terminais ou fragmentos, atuando como um falso positivo que mascarou o defeito em ambiente de integração.

---

### Causa Raiz Comprovada
- **Localização Exata:** [`src/plugin.ts:12-18`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts#L12-L18) (em especial a linha 17).
- **Trecho de Código Vulnerável:**
  ```ts
  export function buildUrl(url: string, params?: Record<string, any>): string {
      if (!params || Object.keys(params).length === 0) return url;
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) qs.append(k, String(v));
      const str = qs.toString();
      return str ? `${url}?${str}` : url;
  }
  ```
- **Fluxo Causal e Rastreamento Reverso de Dados:**
  1. **UI / Componente / Consumidor do Store:**
     O consumidor configura ou consome uma store cuja rota base possui query parameters (ex.: `options.get.route = '/api/v1/orders?type=open'`) e fornece parâmetros dinâmicos de filtro/paginação em `store.get_data = { page: 1 }` (ou `options.get.data`).
  2. **Ciclo de Carregamento Reativo (`loadInServer`):**
     O plugin aciona `loadInServer()` em [`src/plugin.ts:243-244`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts#L243-L244):
     ```ts
     const data_get = getRouteData();
     const route_url = cfg.resolveRoute(route_name, data_get);
     ```
  3. **Resolução de Rota Padrão (`cfg.resolveRoute`):**
     Por padrão, `cfg.resolveRoute` delega diretamente para `buildUrl` ([`src/plugin.ts:55, 71`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts#L55)).
  4. **Concatenação Defeituosa em `buildUrl`:**
     `buildUrl` serializa `data_get` em `str = "page=1"`. Ao avaliar `str ? `${url}?${str}` : url`, interpola com `?`, resultando em `/api/v1/orders?type=open?page=1`.
  5. **Despacho HTTP (Axios):**
     [`src/plugin.ts:249`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts#L249): `axios.get(route_url, ...)` dispara a requisição com a URI contendo duplo `?`.
  6. **Roteamento e Banco de Dados Backend:**
     O roteador do backend falha em identificar `page` como chave independente e interpreta `type` como `open?page=1`, gerando falha no SQL/ORM ou descartando os filtros da query.

---

## Arquivos Afetados

1. [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts) — Refatorar `buildUrl` para inspecionar a presença de query string preexistente na rota base (`?`), selecionar dinamicamente o separador correto (`?` vs `&` ou vazio se já terminar com delimitador) e preservar eventuais fragmentos de hash (`#`).
2. [`test/buildUrl.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/test/buildUrl.test.ts) — Expandir a suíte de testes unitários com todos os cenários omitidos (rotas com query string prévia, múltiplos parâmetros, separadores pontuais, fragmentos de hash e parâmetros nulos).
3. [`test/config.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/test/config.test.ts) — Adicionar teste de integração no ciclo real de carregamento do store (`loadInServer`) validando que rotas configuradas com query strings preexistentes são resolvidas corretamente sem duplo `?` na chamada do Axios.

---

## Execuções Propostas

### 1. Refatoração Cirúrgica de `buildUrl` em [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts)

Substituir a implementação estática de `buildUrl` por um algoritmo robusto e aderente à RFC 3986:
1. Validar se `params` existe e possui chaves; se não, retornar `url` imediatamente.
2. Serializar os parâmetros válidos (descartando `null` e `undefined`) com `URLSearchParams`.
3. Se a query string serializada `str` for vazia (ex.: `params` contendo apenas valores `null`/`undefined`), retornar `url` intacta.
4. Isolar eventual fragmento de hash (`#`) para garantir que a query string seja anexada antes do hash fragment.
5. Determinar o separador dinamicamente:
   - Se a URL base já contiver `?`:
     - Se terminar com `?` ou `&`, nenhum caractere separador adicional é necessário (`''`).
     - Caso contrário, o separador deve ser `'&'`.
   - Se a URL base não contiver `?`:
     - O separador deve ser `'?'`.
6. Montar e retornar `${baseUrl}${separator}${str}${hash}`.

```ts
export function buildUrl(url: string, params?: Record<string, any>): string {
    if (!params || Object.keys(params).length === 0) return url;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) qs.append(k, String(v));
    const str = qs.toString();
    if (!str) return url;

    const hashIndex = url.indexOf('#');
    const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
    const baseUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;

    const hasQuery = baseUrl.includes('?');
    const separator = hasQuery
        ? (baseUrl.endsWith('?') || baseUrl.endsWith('&') ? '' : '&')
        : '?';

    return `${baseUrl}${separator}${str}${hash}`;
}
```

---

### 2. Ampliação da Cobertura de Testes em [`test/buildUrl.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/test/buildUrl.test.ts)

Adicionar testes unitários cobrindo exaustivamente:
- Anexo com separador `&` quando já existe um query parameter prévio (`/user?status=active`, `{ page: 2 }` -> `/user?status=active&page=2`).
- Concatenação correta com múltiplos query parameters prévios (`/user?status=active&sort=desc`, `{ page: 2 }` -> `/user?status=active&sort=desc&page=2`).
- Preservação correta quando a rota base termina com `?` (`/user?`, `{ page: 2 }` -> `/user?page=2`).
- Preservação correta quando a rota base termina com `&` (`/user?status=active&`, `{ page: 2 }` -> `/user?status=active&page=2`).
- Posicionamento correto do query parameter antes de fragmentos `#` (`/user#profile`, `{ id: 1 }` -> `/user?id=1#profile`).
- Posicionamento correto com query parameters prévios e fragmentos `#` (`/user?status=active#section`, `{ page: 2 }` -> `/user?status=active&page=2#section`).
- Retorno da URL intacta quando todos os parâmetros passados forem `null` ou `undefined` em rotas com query prévia (`/user?status=active`, `{ a: null, b: undefined }` -> `/user?status=active`).
- Suporte a URLs absolutas (`https://api.example.com/items?type=all`, `{ limit: 10 }` -> `https://api.example.com/items?type=all&limit=10`).

---

### 3. Integração de Testes em [`test/config.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/test/config.test.ts)

Inserir caso de teste no bloco de carregamento HTTP do store (`loadInServer`):
```ts
it('anexa query string com & quando a rota base configurada já possui parâmetros', async () => {
    const axiosGet = vi.fn().mockResolvedValue({ data: { ok: true } });
    setup({ axios: { get: axiosGet, post: vi.fn() } as any }, () => {
        const isCached = ref(true);
        const data = ref<Record<string, any>>({});
        const options = computed(() => ({
            get: {
                route: '/api/v1/orders?type=open',
                data: { page: 1 }
            }
        }));
        return { isCached, data, options };
    });
    await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
    expect(axiosGet.mock.calls[0][0]).toBe('/api/v1/orders?type=open&page=1');
});
```

---

## Especificação de Teste TDD (Red-Green)

### Cenários Red (Falhas Comprovadas no Código Atual)
Executando os cenários abaixo contra a implementação atual de `buildUrl` ([`src/plugin.ts:12-18`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-9/src/plugin.ts#L12-L18)), obtém-se falha (*Red*):

1. **Cenário Red 1 — Query string preexistente na URL base:**
   ```ts
   expect(buildUrl('/api/items?status=active', { page: 2 }))
       .toBe('/api/items?status=active&page=2');
   // Red: Retorna '/api/items?status=active?page=2' (duplo '?')
   ```

2. **Cenário Red 2 — URL base terminando com `?`:**
   ```ts
   expect(buildUrl('/api/items?', { page: 2 }))
       .toBe('/api/items?page=2');
   // Red: Retorna '/api/items??page=2'
   ```

3. **Cenário Red 3 — URL base terminando com `&`:**
   ```ts
   expect(buildUrl('/api/items?status=active&', { page: 2 }))
       .toBe('/api/items?status=active&page=2');
   // Red: Retorna '/api/items?status=active&?page=2'
   ```

4. **Cenário Red 4 — URL contendo fragmento `#`:**
   ```ts
   expect(buildUrl('/user#profile', { id: 1 }))
       .toBe('/user?id=1#profile');
   // Red: Retorna '/user#profile?id=1' (query anexada ao fragmento)
   ```

5. **Cenário Red 5 — URL contendo query preexistente e fragmento `#`:**
   ```ts
   expect(buildUrl('/api/items?status=active#section', { page: 2 }))
       .toBe('/api/items?status=active&page=2#section');
   // Red: Retorna '/api/items?status=active#section?page=2'
   ```

### Cenários Green (Validação após Correção)
Após a aplicação da nova implementação de `buildUrl`:
- Todos os 5 cenários Red acima passam com sucesso (*Green*).
- Todos os 4 cenários preexistentes de `test/buildUrl.test.ts` continuam passando com sucesso (*Green*).
- O teste de integração em `test/config.test.ts` confirma que `axios.get` recebe `/api/v1/orders?type=open&page=1` (*Green*).

---

## Banco de dados

**Nenhuma** migration ou alteração de banco de dados é necessária. O pacote `@maxvue/max-pinia` é uma biblioteca front-end / cliente de estado para Vue 3 e Pinia.

---

## Riscos de quebra e Não-Regressão

- **Compatibilidade de Contrato Público:** A assinatura da função `buildUrl(url: string, params?: Record<string, any>): string` permanece inalterada.
- **Não-Regressão para Casos Existentes:** Rotas simples sem query string (ex.: `/user` + `{ id: 1 }` -> `/user?id=1`) mantêm exatamente o mesmo comportamento prévio.
- **Parâmetros Vazios ou Falsy:** Chamadas sem parâmetros (`undefined`, `null` ou `{}`) continuam retornando a URL original inalterada. Parâmetros com valores `0`, `false` e `''` continuam sendo serializados corretamente.
- **Suíte de Testes Geral:** Todos os 84 testes pré-existentes da biblioteca (cobrindo `autosave`, `cancelLoad`, `config`, `deduplication`, `internal`, `savePause` e `useAsyncStatus`) devem continuar passando com 100% de sucesso.

---

## Validação

A validação automatizada e conclusiva da implementação será executada através dos seguintes comandos:

1. **Checagem de Tipagem TypeScript:**
   ```bash
   npm run type-check
   ```
   *Critério de aceitação:* 0 erros de compilação reportados pelo `vue-tsc`.

2. **Execução da Suíte Completa de Testes:**
   ```bash
   npm test
   ```
   *Critério de aceitação:* Todos os 8 arquivos de teste aprovados (100% de aprovação nos 84 testes existentes + novos testes).

3. **Execução Focada dos Testes Afetados:**
   ```bash
   npx vitest run test/buildUrl.test.ts test/config.test.ts
   ```
   *Critério de aceitação:* 100% dos testes em `test/buildUrl.test.ts` e `test/config.test.ts` aprovados.

---

## Skills Aplicáveis

- `systematic-debugging-best-practices`
- `planning-with-files`
- `vue-debugging-best-practices`
- `tdd`
- `superpowers`
- `code-review`
- `production-code-audit`
