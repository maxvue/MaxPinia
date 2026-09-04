# Plano de Implementação - Issue #5

## [Audit] Ausência de testes para o pipeline reativo de auto-save e estratégias de deduplicação

### Descrição e Causa Raiz

#### Descrição Detalhada do Problema
O plugin `@maxvue/max-pinia` possui como recurso central a persistência reativa automática (auto-save) e o gerenciamento de concorrência/deduplicação de requisições HTTP (tanto para leitura `GET` quanto para gravação `POST`). 
No entanto, a auditoria de cobertura da suíte de testes identificou que o pipeline reativo e as estratégias de deduplicação implementadas em `src/plugin.ts` (linhas 369 a 464 e linhas 222 a 226) encontram-se desprovidas de testes automatizados dedicados na suíte `vitest`.

Os comportamentos críticos não cobertos incluem:
1. **Pipeline de Auto-Save Reativo:**
   - Detecção de mutações profundas em `store.data` via `watch(() => cloneDeep(store.data))`.
   - Debounce de 300ms via `watchDebounced(() => countChanges.value, () => saveInServer(), { debounce: 300 })`.
   - Mecanismo de guarda contra loops infinitos (`pauseSave()` e `resumeSave()`).
   - Respeito a flags de bloqueio de auto-save (`store.block_save`, `store.no_save`, `store.noSave`, `store.blockSave`, `store.isList`, `store.is_list`).
   - Proteção contra dados vazios ou inalterados (`isBlank(old_val)`, `isBlank(new_val)`, `isEqual(new_val, old_val)`).
2. **Estratégias de Deduplicação de Requisições:**
   - Modos `'last'`, `'cancel'`, `'this'`: aborto de requisições pendentes anteriores via `AbortController.abort()` ao disparar uma nova requisição.
   - Modos `'ignore'`, `'first'`: descarte de novas requisições enquanto houver uma requisição em voo (in-flight).
   - Comportamento idêntico aplicado a `loadInServer()` (GET) e `saveInServer()` (POST).
3. **Higienização de Payload (`removeToSave` / `remove_to_save`):**
   - Remoção de chaves específicas antes do envio do POST através de `unset(data_send, remove[k])`.
4. **Ciclo Pós-Salvamento (`save_return` e `reload_after_save`):**
   - Atualização de `store.data` com a resposta do servidor sob controle de `pauseSave()` para evitar auto-save em cascata.
   - Disparo de `loadInServer()` após gravação bem-sucedida caso `reload_after_save` esteja habilitado.

#### Causa Raiz Comprovada
- **Localização exata no código:** [`src/plugin.ts:L369-464`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L369-464) e [`src/plugin.ts:L222-226`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L222-226).
- **Fluxo Causal:**
  1. A aplicação/UI muta propriedades em `store.data`.
  2. O watcher [`src/plugin.ts:L456`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L456) detecta a alteração; caso não esteja pausado (`!is_save_in_pause.value`) e os dados não sejam vazios nem idênticos, incrementa `countChanges.value`.
  3. `watchDebounced` ([`src/plugin.ts:L463`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L463)) agenda a execução de `saveInServer()` após 300ms.
  4. `saveInServer` ([`src/plugin.ts:L380`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L380)) inspeciona `signal_post_request.value` e aplica a regra de `postInDeduplication()` ([`src/plugin.ts:L390-393`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L390-393)).
  5. O payload `data_send` é filtrado com base em `store.removeToSave` ([`src/plugin.ts:L416-419`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-5/src/plugin.ts#L416-419)) e enviado via `axios.post` com `AbortSignal`.
  6. Ao responder, atualiza `store.data` (se `save_return`), dispara `saveInCache()` e opcionalmente `loadInServer()` (se `reload_after_save`).
- **Rastreamento Reverso de Dados:**
  `UI (Vue Component)` ⇄ `Pinia Store (store.data, store.options)` ⇄ `MaxPinia Plugin Watcher & Debounce` ⇄ `Deduplication & AbortController` ⇄ `Axios HTTP Client` ⇄ `Backend API / Storage`.

---

### Arquivos afetados

- **`test/autosave.test.ts`** *(Novo arquivo)*: Suíte de testes unitários e de integração cobrindo o pipeline reativo de auto-save (mutações em `store.data`, debounce de 300ms com fake timers, flags de bloqueio, sanitização via `removeToSave`, `save_return`, e `reload_after_save`).
- **`test/deduplication.test.ts`** *(Novo arquivo)*: Suíte de testes dedicada às estratégias de deduplicação (`'last'`, `'cancel'`, `'this'`, `'ignore'`, `'first'`) tanto para leitura (`loadInServer`) quanto para gravação (`saveInServer`), validando o acionamento e aborto de `AbortController`.
- **`docs/issues/5/plan.md`**: Registro do plano de implementação detalhado.

---

### Execuções propostas

1. **Configuração do Ambiente de Testes com Suporte a Fake Timers e AbortController:**
   - Utilizar as ferramentas padrão do `vitest` (`vi.useFakeTimers()`, `vi.advanceTimersByTime()`, `vi.fn()`) para controlar com precisão os 300ms do `watchDebounced` e o tempo de 1ms de `resumeSave()`.
   - Mockar a instância do `axios` (`axios.get` e `axios.post`) retornando promessas controladas que permitem testar requisições pendentes (in-flight) e verificar sinais `signal.aborted`.

2. **Criação da Suíte de Testes `test/autosave.test.ts`:**
   - **Caso 1: Auto-save reativo com debounce:**
     - Mutar `store.data.field = 'valor1'`, avançar o tempo em 150ms (garantir que `axios.post` NÃO foi chamado), mutar `store.data.field = 'valor2'`, avançar 300ms e confirmar que `axios.post` foi chamado exatamente 1 vez com `'valor2'`.
   - **Caso 2: Bloqueio de salvamento por flags:**
     - Definir `store.block_save = true` (ou `no_save`, `blockSave`, `isList`). Mutar `store.data`, avançar os timers e validar que nenhuma requisição POST é disparada.
   - **Caso 3: Remoção de chaves via `removeToSave` / `remove_to_save`:**
     - Configurar `store.removeToSave = ['tempToken', 'nested.internal']` e `store.data = { name: 'Teste', tempToken: '123', nested: { internal: true, keep: 42 } }`.
     - Disparar `saveInServer()` e validar que o payload recebido por `axios.post` não contém `tempToken` nem `nested.internal`, mantendo `name` e `nested.keep`.
   - **Caso 4: Tratamento de `save_return`:**
     - Testar `store.save_return = true` atualizando `store.data` com a resposta do backend sem disparar novo loop de auto-save.
     - Testar `store.save_return = 'id'` atualizando apenas se a chave divergir.
   - **Caso 5: Recarga automática via `reload_after_save`:**
     - Configurar `store.reload_after_save = true`. Após conclusão do `axios.post`, verificar se `axios.get` (`loadInServer`) é invocado.

3. **Criação da Suíte de Testes `test/deduplication.test.ts`:**
   - **Caso 1: Deduplicação POST com estratégia `'last'` / `'cancel'` / `'this'` (Padrão):**
     - Iniciar primeiro `saveInServer()`, deixando a promise pendente.
     - Disparar segundo `saveInServer()`.
     - Validar que o `signal` da primeira requisição teve `aborted === true`.
   - **Caso 2: Deduplicação POST com estratégia `'ignore'` / `'first'`:**
     - Iniciar primeiro `saveInServer()`, deixando a promise pendente.
     - Disparar segundo `saveInServer()`.
     - Validar que a segunda chamada é imediatamente ignorada e apenas 1 chamada `axios.post` foi efetuada.
   - **Caso 3: Deduplicação GET (`loadInServer`) com estratégia `'last'` / `'cancel'`:**
     - Disparar duas cargas simultâneas com `in_deduplication = 'cancel'` e verificar que o sinal da primeira requisição GET foi abortado.
   - **Caso 4: Deduplicação GET (`loadInServer`) com estratégia `'ignore'` / `'first'`:**
     - Disparar duas cargas com `in_deduplication = 'ignore'` e validar que a segunda requisição GET não é disparada.

4. **Verificação de Cobertura e Não-Regressão:**
   - Executar `npm run test:coverage` e assegurar que as linhas 369-464 de `src/plugin.ts` alcancem cobertura abrangente (>95%), sem falhas na suíte pré-existente (`test/config.test.ts`, `test/internal.test.ts`, `test/buildUrl.test.ts`).

---

### Especificação de Teste TDD (Red-Green)

#### Teste Red (Reprodução da Falha de Cobertura)
- Executar `npm run test:coverage` no estado atual.
- Observar a ausência de arquivos de teste para auto-save e deduplicação (`test/autosave.test.ts` e `test/deduplication.test.ts` inexistentes) e linhas descobertas em `src/plugin.ts` (369-464).

#### Teste Green (Validação da Implementação)
- Implementar as suítes de teste em `test/autosave.test.ts` e `test/deduplication.test.ts`.
- Executar `npm run test:coverage`.
- Todos os testes passam com status de sucesso (`✓`) e a cobertura de linhas de `src/plugin.ts` sobe para o patamar esperado (>95%).

---

### Banco de dados

Nenhuma migration necessária. O projeto é uma biblioteca frontend (plugin Pinia).

---

### Riscos de quebra e Não-Regressão

- **Isolamento de Timers com Vue Reativo:** O uso de `vi.useFakeTimers()` em testes com Vue 3 e `@vueuse/core` (`watchDebounced`) pode impactar microtasks do Vue se não for devidamente sincronizado (`vi.advanceTimersByTime(300)` acompanhado de `await nextTick()`). A estrutura dos testes deve garantir a limpeza de mocks em `afterEach`/`beforeEach`.
- **Compatibilidade de Interfaces:** Nenhuma alteração de contrato público em `createMaxPinia` ou `types.ts` é realizada, garantindo 100% de retrocompatibilidade com aplicações consumidoras.

---

### Validação

Executar o comando:
```bash
npm run test:coverage
```
Critérios de aceitação:
- 100% dos testes unitários e de integração executados com sucesso (0 falhas).
- Testes cobrindo explicitamente:
  - Debounce de 300ms do auto-save.
  - Modos de deduplicação `'last'`, `'cancel'`, `'this'`, `'ignore'`, `'first'` para GET e POST.
  - Sanitização de campos via `removeToSave` / `remove_to_save`.
  - Flags de controle (`save_return`, `reload_after_save`, `block_save`).

---

### Skills Aplicáveis

- `planning-with-files`
- `systematic-debugging-best-practices`
- `vue-debugging-best-practices`
- `tdd`
- `production-code-audit`
