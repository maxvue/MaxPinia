# Plano de Implementação - Issue #8

## Descrição e Causa Raiz

### Descrição Detalhada do Problema e Agravantes
Durante a execução do método `saveInServer` no plugin `@maxvue/max-pinia` ([`src/plugin.ts:388-456`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts#L388-L456)), o payload a ser despachado ao backend via requisição HTTP POST é instanciado através de uma cópia rasa (*shallow copy*):
```ts
const data_send = getPostData() ?? { ...store.data };
```
Em seguida, caso a store possua regras de higienização de payload definidas através de `store.removeToSave` ou `store.remove_to_save`, o plugin itera sobre cada caminho declarado e invoca o utilitário `unset` da biblioteca `lodash-es` diretamente sobre `data_send`:
```ts
if (store.removeToSave || store.remove_to_save) {
    const remove = store.removeToSave ?? store.remove_to_save;
    for (const k in remove) unset(data_send, remove[k]);
}
```
A função `unset(object, path)` do `lodash-es` localiza o nó pai imediato da chave informada e executa a operação `delete` in-place na memória do JavaScript. 

Como o operador spread `{ ...store.data }` (e de forma análoga a montagem de `getPostData()` na linha 384) clona apenas o primeiro nível de propriedades, quaisquer nós ou objetos aninhados (por exemplo: `store.data.user.tempToken`, `store.data.nested.internal`, `store.data.meta.tempField`) continuam compartilhando a exata mesma referência de memória entre o objeto de envio `data_send` e o estado reativo local `store.data`.

Ao executar `unset(data_send, path)` para caminhos aninhados, a deleção física ocorre dentro do próprio objeto referenciado no estado reativo `store.data` da aplicação cliente.

#### Agravantes
1. **Corrupção Silenciosa e Destrutiva do Estado Reativo do Cliente:**
   Diferente de propriedades de primeiro nível (como `store.data.tempToken`), que são copiadas por valor primitivo e portanto preservadas no estado reativo, propriedades aninhadas são destruídas em tempo de execução sem consentimento ou aviso. O estado do cliente deixa de refletir a verdade de seus dados imediatamente após qualquer salvamento automático ou manual.
2. **Falhas em Cascata e Quebra da Interface do Usuário (UI):**
   Componentes Vue que dependem de reatividade em nós aninhados (ex.: diretivas `v-if="store.data.user.tempToken"`, propriedades computadas `computed` ou observadores `watch`) recebem abruptamente o valor `undefined`. Isso desencadeia erros de tempo de execução como `TypeError: Cannot read properties of undefined`, quebra fluxos de preenchimento em telas de edição e invalida tokens/metadados transitórios essenciais para o fluxo da UI.
3. **Persistência de Dados Corrompidos no Cache Offline (`localforage`):**
   Após a requisição HTTP, o fluxo de `saveInServer` invoca `saveInCache()` ([`src/plugin.ts:443`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts#L443)), que clona e persiste o conteúdo atual de `store.data` no IndexedDB via `localforage`. Como o estado local já foi corrompido pela mutação do `unset`, o dado defeituoso (com propriedades aninhadas removidas) é gravado no storage local. Caso a aplicação não utilize `save_return: true`, o dado corrompido persistirá no cache mesmo após o recarregamento da página (F5) ou reinicialização da aplicação offline.
4. **Falsa Sensação de Cobertura nos Testes Pré-existentes:**
   No teste existente em [`test/autosave.test.ts:201-230`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/test/autosave.test.ts#L201-L230) (`Caso 3: Remoção de chaves via removeToSave e remove_to_save`), apenas o payload recebido pelo mock de `axios.post` foi verificado (`expect(sentPayload.nested).not.toHaveProperty('internal')`). A integridade do estado original da store (`store.data.nested`) não foi checada, permitindo que a mutação destrutiva passasse despercebida na auditoria original.

---

### Causa Raiz Comprovada

- **Localização Exata:**
  - Instanciação rasa do payload: [`src/plugin.ts:391`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts#L391)
  - Mutação destrutiva in-place: [`src/plugin.ts:426-429`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts#L426-L429)
  - Cópia rasa auxiliar em `getPostData`: [`src/plugin.ts:383-385`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts#L383-L385)

- **Trecho de Código Vulnerável:**
  ```ts
  // src/plugin.ts:391
  const data_send = getPostData() ?? { ...store.data };

  // src/plugin.ts:426-429
  if (store.removeToSave || store.remove_to_save) {
      const remove = store.removeToSave ?? store.remove_to_save;
      for (const k in remove) unset(data_send, remove[k]);
  }
  ```

- **Fluxo Causal:**
  1. O consumidor define uma store Pinia reativa contendo dados aninhados em `store.data` (ex.: `{ name: 'Teste Sanitizado', nested: { internal: true, keep: 42 } }`).
  2. O consumidor define `store.removeToSave = ['tempToken', 'nested.internal']` com a expectativa de que tais campos sejam suprimidos apenas da mensagem HTTP POST enviada ao servidor.
  3. Ao invocar `store.saveInServer()`, a variável `data_send` é gerada com o operador spread `{ ...store.data }` (ou a partir de `getPostData()`). O primeiro nível é clonado, mas `data_send.nested` preserva a referência original do objeto `store.data.nested`.
  4. O laço de higienização executa `unset(data_send, 'nested.internal')`.
  5. `unset` executa `delete data_send.nested.internal`. Devido ao compartilhamento de ponteiro em memória, a propriedade `internal` é removida fisicamente de `store.data.nested`.
  6. O payload despachado ao `axios.post` não contém `nested.internal`, mas o estado do cliente local sofreu corrupção permanente.

- **Rastreamento Reverso de Dados:**
  `UI / Componentes Vue (Bindings & Computed)` ⇄ `Store Pinia Reativa (store.data em memória)` ⇄ `Plugin MaxPinia (saveInServer / data_send raso ⇄ unset destrutivo)` ⇄ `Cache Local (saveInCache persistindo store.data corrompido em localforage)` ⇄ `Cliente HTTP Axios (axios.post com payload gerado)` ⇄ `API / Backend Controller`.

---

## Arquivos afetados

1. [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts)
   - Substituição da cópia rasa na linha 391 por clonagem profunda completa (`cloneDeep`) isolando o payload de qualquer referência em memória com `store.data` ou com o resultado de `getPostData()`, desembrulhando o proxy reativo via `toRaw`:
     ```ts
     const data_send = cloneDeep(toRaw(getPostData() ?? store.data) ?? {});
     ```
2. [`test/autosave.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/test/autosave.test.ts)
   - Atualização do teste `Caso 3: Remoção de chaves via removeToSave e remove_to_save` (linhas 201-230) com asserções explícitas comprovando que `store.data.tempToken` e `store.data.nested.internal` continuam estritamente intactos no estado reativo local após a execução de `saveInServer()`.
   - Criação de novos casos de teste dedicados:
     - Validação de estruturas com aninhamento profundo (múltiplos níveis de objetos e arrays) sob `removeToSave` e `remove_to_save`.
     - Validação de que fontes customizadas via `getSaveData` / `post_data` com objetos aninhados também são protegidas contra mutação colateral.
3. [`docs/issues/8/plan.md`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/docs/issues/8/plan.md)
   - Registro técnico detalhado do plano de implementação e especificações de garantia de qualidade.

---

## Execuções propostas

### Passo 1: Correção Cirúrgica em [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/src/plugin.ts)
Modificar a linha 391 de `src/plugin.ts` para aplicar clonagem profunda e desempacotamento de proxy reativo:

```ts
// ANTES (Vulnerável a mutação de nós aninhados compartilhados):
const data_send = getPostData() ?? { ...store.data };

// DEPOIS (Isolamento total e imunidade a mutações colaterais):
const data_send = cloneDeep(toRaw(getPostData() ?? store.data) ?? {});
```

#### Fundamentação Técnica da Modificação:
- **Hierarquia de Fontes Mantida:** `getPostData()` continua com precedência sobre `store.data`. Se o desenvolvedor proveu `getSaveData`, `post_data` ou variações de opções, esses valores continuam sendo honrados prioritariamente.
- **Desempacotamento Seguro com `toRaw`:** `toRaw(...)` (já importado de `'vue'` na linha 1 de `src/plugin.ts`) desembrulha o objeto reativo original caso `store.data` seja um `reactive proxy` ou `ref`, evitando a ativação contínua e onerosa de getters reativos durante a travessia de propriedades (seguindo o padrão consolidado na linha 356: `cleanData = cloneDeep(toRaw(data))`).
- **Resiliência a Nulos/Indefinidos:** Se tanto `getPostData()` quanto `store.data` forem `null` ou `undefined`, o operador `?? {}` garante um objeto vazio, preservando o comportamento da verificação subsequente `if (size(data_send) === 0) return;`.
- **Independência Total em Memória:** `cloneDeep` (já importado de `'lodash-es'` na linha 4 de `src/plugin.ts`) produz uma árvore de nós 100% nova. As subsequentes chamadas de `unset(data_send, remove[k])` realizam deleções restritas à cópia em trânsito, mantendo `store.data` absolutamente inalterado.

### Passo 2: Atualização e Expansão dos Testes em [`test/autosave.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/test/autosave.test.ts)

1. **Reforçar o Caso 3 Existente:**
   Complementar as asserções de [`test/autosave.test.ts:223-230`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-8/test/autosave.test.ts#L223-L230) com a verificação do estado reativo `store.data`:
   ```ts
   // Validação da higienização no envio HTTP
   const sentPayload = axiosPost.mock.calls[0][1];
   expect(sentPayload).toEqual({
       name: 'Teste Sanitizado',
       nested: { keep: 42 }
   });
   expect(sentPayload).not.toHaveProperty('tempToken');
   expect(sentPayload.nested).not.toHaveProperty('internal');

   // Validação crucial de não-destrutividade do estado local:
   expect(store.data.tempToken).toBe('secret_123');
   expect(store.data.nested).toEqual({ internal: true, keep: 42 });
   expect(store.data.nested.internal).toBe(true);
   ```

2. **Adicionar Caso 3.2: Imunidade a mutação destrutiva em profundidade multinível:**
   ```ts
   it('Caso 3.2: Não muta propriedades aninhadas profundas em store.data com removeToSave', async () => {
       const axiosPost = vi.fn().mockResolvedValue({ data: {} });
       const store = setupStore(
           { axios: { get: vi.fn().mockResolvedValue({ data: {} }), post: axiosPost } as any },
           () => {
               const isCached = ref(true);
               const data = ref({
                   id: 1,
                   user: {
                       profile: {
                           secretToken: 'secret-xyz',
                           displayName: 'Carlos'
                       }
                   },
                   meta: { tempFlag: true, version: 1 }
               });
               const removeToSave = ['user.profile.secretToken', 'meta.tempFlag'];
               const options = computed(() => ({ save: '/api/profile' }));
               return { isCached, data, removeToSave, options };
           }
       );

       await vi.advanceTimersByTimeAsync(10);
       await store.saveInServer();

       // Payload sanitizado
       const sentPayload = axiosPost.mock.calls[0][1];
       expect(sentPayload.user.profile).toEqual({ displayName: 'Carlos' });
       expect(sentPayload.meta).toEqual({ version: 1 });

       // Estado reativo íntegro e intocado
       expect(store.data.user.profile.secretToken).toBe('secret-xyz');
       expect(store.data.user.profile.displayName).toBe('Carlos');
       expect(store.data.meta.tempFlag).toBe(true);
       expect(store.data.meta.version).toBe(1);
   });
   ```

3. **Adicionar Caso 3.3: Imunidade a mutação com payload proveniente de getSaveData:**
   Verificar que quando `getSaveData` retorna um objeto com referências aninhadas, o `unset` não muta a fonte original retornada pela função.

---

## Especificação de Teste TDD (Red-Green)

### 1. Teste Red (Reprodução da Falha Antes da Correção)
- **Cenário:** Store configurada com `store.data = { name: 'Teste', nested: { internal: true, keep: 42 } }` e `store.removeToSave = ['nested.internal']`.
- **Ação:** Executar `await store.saveInServer()`.
- **Resultado Red Obtido no Código Atual:**
  - O assert `expect(store.data.nested.internal).toBe(true)` **falha**.
  - Saída do erro:
    ```
    AssertionError: expected undefined to be true
    - Expected: true
    + Received: undefined
    ```
  - Evidência incontestável de que `unset` deletou a propriedade diretamente do estado reativo do cliente.

### 2. Teste Green (Validação da Correção)
- **Ação:** Substituir a linha 391 por `const data_send = cloneDeep(toRaw(getPostData() ?? store.data) ?? {});`.
- **Resultado Green Esperado:**
  - O assert `expect(store.data.nested.internal).toBe(true)` **passa com 100% de sucesso**.
  - O payload enviado ao `axios.post` permanece sanitizado sem `nested.internal`.
  - O estado local da store permanece íntegro com `{ internal: true, keep: 42 }`.

---

## Banco de dados

**Nenhuma.** O projeto `@maxvue/max-pinia` é uma biblioteca client-side (plugin Pinia para ecossistema Vue 3). O gerenciamento de persistência local é executado via `localforage` (IndexedDB/WebSQL/localStorage no browser) e o tráfego de dados é intermediado via HTTP (`axios`). Nenhuma alteração de schema ou migration de banco de dados relacional é aplicável.

---

## Riscos de quebra e Não-Regressão

- **Compatibilidade de API e Contratos Públicos:**
  - Risco: **Nenhum**. Nenhuma assinatura de função, interface TypeScript em `src/types.ts` ou propriedade de configuração pública é alterada.
  - A estrutura do payload JSON despachado via POST para o backend permanece rigorosamente idêntica.
- **Desempenho e Sobrecarga de Memória:**
  - Risco: **Desprezível**. `cloneDeep` de `lodash-es` já faz parte do bundle da biblioteca e é amplamente utilizado nos ciclos de cache e watchers do plugin.
  - A invocação prévia de `toRaw(...)` previne a travessia de handlers de Proxy reativo, tornando o processo de clonagem profunda ágil mesmo para payloads médios/grandes.
- **Não-Regressão da Suíte de Testes:**
  - Todas as 8 suítes existentes (`test/autosave.test.ts`, `test/savePause.test.ts`, `test/deduplication.test.ts`, `test/config.test.ts`, `test/buildUrl.test.ts`, `test/internal.test.ts`, `test/cancelLoad.test.ts`, `test/useAsyncStatus.test.ts`) devem continuar com 100% de aprovação (84 testes passando sem regressão).
  - O pipeline de auto-save com debounce de 300ms, deduplicação de requisições, tratamento de `save_return` e `reload_after_save` permanece perfeitamente intacto.

---

## Validação

A validação automatizada e conclusiva da implementação será realizada através dos seguintes comandos:

```bash
# 1. Verificação estrita de tipagem TypeScript (código de saída 0, 0 erros)
npm run type-check

# 2. Execução da suíte completa de testes unitários e de integração
npm test

# 3. Verificação de cobertura total de código
npm run test:coverage
```

### Critérios de Aceitação para Sucesso:
1. `vue-tsc --noEmit` conclui com 0 erros de compilação.
2. 100% dos testes unitários executam e passam no `vitest` (86+ testes com os novos casos de Issue #8).
3. Cobertura de declarações (`Stmts`) e linhas (`Lines`) em `src/plugin.ts` permanece em 100%.
4. A mutação em `store.data` por `removeToSave` ou `remove_to_save` em nós aninhados é comprovadamente eliminada.

---

## Skills Aplicáveis

- `systematic-debugging-best-practices`
- `vue-debugging-best-practices`
- `tdd`
- `planning-with-files`
- `superpowers`
- `code-review`
- `production-code-audit`
