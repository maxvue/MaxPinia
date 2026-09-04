# Plano de Execução - Issue #4: [Audit] Header X-CSRF-TOKEN nulo enviado incondicionalmente em saveInServer

## Descrição e Causa Raiz

### Descrição Detalhada
Durante a auditoria automatizada de segurança (Lente 5 - Segurança / OWASP), identificou-se que o método `saveInServer()` em [src/plugin.ts](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts#L407-L412) injeta incondicionalmente o cabeçalho HTTP `'X-CSRF-TOKEN': cfg.getSessionToken()` no objeto de configuração do Axios.

Por padrão, quando a aplicação inicializa o MaxPinia sem especificar a função `getSessionToken` (ou seja, `createMaxPinia({})`), a configuração interna assume o fallback padrão `getSessionToken: () => null` ([src/plugin.ts:51](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts#L51) e [src/plugin.ts:67](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts#L67)).

**Agravantes:**
1. **Falha de Integridade HTTP / Rejeição por Backends:** Backends com validações estritas de cabeçalhos (como middlewares de CSRF do Laravel `VerifyCsrfToken`, Symfony Security, Spring Security, Express `csurf`/`helmet`, ou firewalls de aplicação Web / WAFs) ao receberem o cabeçalho `X-CSRF-TOKEN` com valor `null` ou string literal `"null"` rejeitam a requisição com códigos HTTP 400 (Bad Request), 419 (Page Expired / CSRF Token Mismatch) ou 422 (Unprocessable Entity).
2. **Poluição de Headers em APIs Stateless:** Para endpoints e APIs stateless/públicas que não utilizam proteção CSRF baseada em cabeçalhos de sessão, a presença explícita de um cabeçalho nulo polui o payload de metadados da requisição e quebra a conformidade com as boas práticas HTTP.

### Causa Raiz Comprovada
- **Localização Exata:** [src/plugin.ts:401-414](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts#L401-L414)
- **Rastreamento Reverso de Dados:**
  1. `createMaxPinia(userConfig)` instancia o objeto de configuração resolvido `cfg`, associando `getSessionToken: userConfig.getSessionToken ?? (() => null)` ([src/plugin.ts:51, 67](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts#L51)).
  2. Um componente Vue ou trigger de persistência executa a ação de salvamento: `store.saveInServer()`.
  3. `saveInServer()` monta o objeto de configuração da requisição Axios:
     ```ts
     const axiosConfig = {
         timeout: cfg.requestTimeout,
         signal: signal_post_request.value.signal,
         onDownloadProgress: (progressEvent: any) => {
             progress_loading.value = progressEvent.loaded / progressEvent.total;
         },
         headers: {
             Accept: 'application/json',
             'Content-Type': 'application/json',
             'X-CSRF-TOKEN': cfg.getSessionToken(),
             'X-Requested-With': 'XMLHttpRequest'
         },
         withCredentials: true
     };
     ```
  4. Como `cfg.getSessionToken()` avalia para `null` (ou `undefined` / `""`), a chave `'X-CSRF-TOKEN'` é registrada diretamente com valor `null` no dicionário de `headers`.
  5. A chamada `axios.post(cfg.resolveRoute(route_name), data_send, axiosConfig)` despacha o cabeçalho com valor `null` para o servidor backend.

---

## Arquivos Afetados

- [src/plugin.ts](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts) — Ajuste na instanciação do objeto `headers` em `saveInServer()` para anexar o cabeçalho `'X-CSRF-TOKEN'` somente quando `cfg.getSessionToken()` retornar um token válido (não nulo e não vazio).
- [test/config.test.ts](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/test/config.test.ts) — Adição de testes unitários automatizados validando a omissão do cabeçalho quando o token for nulo/ausente e a inclusão correta quando o token estiver presente.

---

## Execuções Propostas

1. **Elaboração de Testes TDD (Red Phase):**
   - Adicionar casos de teste em [test/config.test.ts](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/test/config.test.ts):
     - Validar que em uma instância criada com `createMaxPinia({})` (sem `getSessionToken`) ou `getSessionToken: () => null`, a requisição POST de `store.saveInServer()` **não** possui a propriedade `'X-CSRF-TOKEN'` nos `headers` enviados ao Axios.
     - Validar que em uma instância criada com `getSessionToken: () => 'my-custom-csrf-token'`, a requisição POST inclui `'X-CSRF-TOKEN': 'my-custom-csrf-token'`.
     - Validar que retornos falsy/vazios (`undefined`, `''`) também não geram o header `'X-CSRF-TOKEN'`.

2. **Modificação Cirúrgica no Código (Green Phase):**
   - No arquivo [src/plugin.ts](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/plugin.ts), dentro de `saveInServer()`:
     ```ts
     const sessionToken = cfg.getSessionToken();
     const headers: Record<string, string> = {
         Accept: 'application/json',
         'Content-Type': 'application/json',
         'X-Requested-With': 'XMLHttpRequest',
         ...(sessionToken ? { 'X-CSRF-TOKEN': sessionToken } : {})
     };
     ```
   - Substituir a definição literal estática de `headers` em `axiosConfig` pelo objeto `headers` condicionado.

3. **Verificação de Regressão e Validação da Suite:**
   - Executar a suite completa do Vitest (`npm test`).
   - Executar checagem de tipos estática (`npm run type-check`).
   - Executar build do pacote (`npm run build`).

---

## Especificação de Teste TDD (Red-Green)

### Testes a adicionar em `test/config.test.ts`:

```ts
it('não envia header X-CSRF-TOKEN quando getSessionToken retorna null ou não é informado', async () => {
    const axiosPost = vi.fn().mockResolvedValue({ data: {} });
    const store = setup(
        { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
        () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ name: 'test' });
            const options = computed(() => ({ save: 'my.save.route' }));
            return { isCached, data, options };
        }
    );

    store.saveInServer();
    await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());

    const postConfig = axiosPost.mock.calls[0][2];
    expect(postConfig.headers).not.toHaveProperty('X-CSRF-TOKEN');
});

it('envia header X-CSRF-TOKEN quando getSessionToken retorna um token válido', async () => {
    const axiosPost = vi.fn().mockResolvedValue({ data: {} });
    const store = setup(
        {
            axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any,
            getSessionToken: () => 'csrf-secret-abc-123'
        },
        () => {
            const isCached = ref(true);
            const data = ref<Record<string, any>>({ name: 'test' });
            const options = computed(() => ({ save: 'my.save.route' }));
            return { isCached, data, options };
        }
    );

    store.saveInServer();
    await vi.waitFor(() => expect(axiosPost).toHaveBeenCalled());

    const postConfig = axiosPost.mock.calls[0][2];
    expect(postConfig.headers['X-CSRF-TOKEN']).toBe('csrf-secret-abc-123');
});
```

- **Comportamento Red:** Antes da alteração em `src/plugin.ts`, o primeiro teste falhará pois `postConfig.headers` conterá `'X-CSRF-TOKEN': null`.
- **Comportamento Green:** Após a alteração, o header não existirá no dicionário de headers quando o token for nulo, passando com sucesso.

---

## Banco de dados

Nenhuma migration necessária. A alteração é restrita ao plugin client-side de sincronização HTTP do Pinia.

---

## Riscos de quebra e Não-Regressão

- **Quebra de Contrato:** Risco nulo. O tipo `getSessionToken?: () => string | null | undefined` em [src/types.ts](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-4/src/types.ts#L50) já prevê `null` ou `undefined`.
- **Compatibilidade com Aplicações Existentes:** Aplicações que já forneciam um token válido via `getSessionToken` continuarão enviando o header `X-CSRF-TOKEN` normalmente. Aplicações que não forneciam a função ou retornavam `null` deixarão de enviar um header malformado, corrigindo comportamentos anômalos em backends estritos.
- **Testes de Não-Regressão:** Execução de todos os 23 testes pré-existentes do repositório para garantir que `buildUrl`, `resolveRoute`, `onActivity`, deduplicação e cache localforage permanecem 100% funcionais.

---

## Validação

- `npm test` — Execução de todos os testes unitários via Vitest, incluindo os novos testes de cabeçalho CSRF condicional.
- `npm run type-check` — Validação estrita de TypeScript via `vue-tsc --noEmit`.
- `npm run build` — Validação do bundle final com `vite build` e geração de d.ts com `vite-plugin-dts`.

---

## Skills Aplicáveis

- `systematic-debugging-best-practices`
- `planning-with-files`
- `tdd`
- `code-review`
- `production-code-audit`
