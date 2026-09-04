# Plano de Implementação - Issue #2

## Descrição e Causa Raiz

### Descrição do Problema
O plugin `@maxvue/max-pinia` gerencia a reatividade de stores do Pinia, sincronizando alterações de `store.data` com o cache offline (`localforage`) e o servidor via requisições HTTP (`saveInServer` acionado por `watchDebounced` em `countChanges`).

Para evitar loops infinitos e envios indevidos ao servidor durante carregamentos e redefinições internas (`loadInServer`, `loadInCache`, `setDefaultData` e respostas de `save_return`), o plugin utiliza um mecanismo de pausa temporária da gravação (`pauseSave` e `resumeSave`).

Atualmente, `resumeSave` em [`src/plugin.ts:451-454`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L451-L454) está implementado como:
```ts
const is_save_in_pause: Ref = ref(true);
const pauseSave = () => { is_save_in_pause.value = true; };
const resumeSave = () => { setTimeout(() => { is_save_in_pause.value = false; }, 1); };
```

Essa abordagem introduz falhas graves no ciclo de vida da aplicação:
1. **Perda silenciosa de mutações em microtasks (Data Loss):** Mutações realizadas pelo consumidor logo após uma inicialização, `await store.loadInServer()`, `await store.reload()` ou no hook `store.afterLoad()` disparam a fila de reatividade do Vue (microtasks). Como `setTimeout(..., 1)` reside na fila de macrotasks, o watcher [`src/plugin.ts:456-461`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L456-L461) executa enquanto `is_save_in_pause.value` ainda é `true`, abortando o incremento de `countChanges`. As alterações do usuário são perdidas e jamais enviadas ao backend.
2. **Race condition e falta de controle de reentrância:** `resumeSave` não cancela timers prévios nem implementa contagem de referência (`pauseDepth`). Se múltiplas operações assíncronas ocorrerem em sequência (ex.: `loadInCache` seguido de `loadInServer`), o timer do primeiro `resumeSave` pode disparar e definir `is_save_in_pause.value = false` no meio de uma segunda carga que deveria estar pausada, causando disparos acidentais de `saveInServer`.
3. **Não-determinismo em testes e ambientes assíncronos:** O uso de macrotasks arbitrárias de 1ms quebra a sincronia com `await nextTick()` do Vue, gerando testes flakies e incompatibilidade com `vi.useFakeTimers()`.

### Causa Raiz Comprovada
- **Localização Exata:** [`src/plugin.ts:451-454`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L451-L454) e chamadas associadas em [`src/plugin.ts:243-250`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L243-L250), [`src/plugin.ts:293-308`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L293-L308), [`src/plugin.ts:425-429`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L425-L429) e [`src/plugin.ts:470-478`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts#L470-L478).
- **Mecanismo Causal:** 
  - O loop de eventos do JavaScript prioriza a drenagem completa da fila de Microtasks antes de executar o próximo Macrotask (`setTimeout`).
  - O escalonador de efeitos do Vue 3 executa os callbacks de `watch` em microtasks (via `flush: 'pre'` padrão).
  - O intervalo de macrotask criado por `setTimeout(..., 1)` causa um descompasso temporal: o estado `is_save_in_pause.value` permanece `true` durante toda a cadeia de microtasks subsequente às operações síncronas/assíncronas imediatas.
- **Rastreamento Reverso de Dados:**
  `UI / Componente / App Consumer` ⇄ `Store (store.data / store.afterLoad / loadInServer)` ⇄ `Reatividade Vue 3 (watch(store.data) ⇄ is_save_in_pause ⇄ countChanges ⇄ watchDebounced)` ⇄ `API / Axios (saveInServer / axios.post)` ⇄ `Controller / Backend DB / localforage Cache`.

---

## Arquivos afetados

1. [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts) - Importação de `nextTick` do Vue, refatoração de `pauseSave` e `resumeSave` para controle determinístico via microtasks (`nextTick`) com suporte a reentrância/profundidade (`pauseDepth`).
2. [`test/savePause.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/test/savePause.test.ts) - Novo arquivo de teste unitário/integração validando cenários de TDD (reprodução do Red com `setTimeout` e garantia do Green com `nextTick`, reentrância e mutações no ciclo de vida).

---

## Execuções propostas

### Passo 1: Atualizar importações em [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts)
Incluir `nextTick` na importação de `'vue'`:
```ts
import { ref, computed, watch, nextTick, toValue, toRaw, type Ref } from 'vue';
```

### Passo 2: Refatorar `pauseSave` e `resumeSave` em [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/plugin.ts)
Substituir o temporizador não-determinístico `setTimeout` por sincronização determinística via `nextTick` com controle de profundidade reentrante:
```ts
let pauseDepth = 0;
const is_save_in_pause: Ref<boolean> = ref(true);

const pauseSave = () => {
    pauseDepth++;
    is_save_in_pause.value = true;
};

const resumeSave = () => {
    nextTick(() => {
        pauseDepth = Math.max(0, pauseDepth - 1);
        if (pauseDepth === 0) {
            is_save_in_pause.value = false;
        }
    });
};
```

### Passo 3: Garantir consistência nas chamadas de `resumeSave`
Verificar todos os pontos de chamada de `pauseSave()` e `resumeSave()`:
- `watch(() => [store.id, store.enabled, store.options?.enabled], ...)`: `pauseSave() -> setDefaultData() -> resumeSave()`.
- `loadInServer`: `pauseSave() -> store.data = ... -> resumeSave()`.
- `loadInCache`: `pauseSave() -> store.data = ... -> resumeSave()` (incluindo bloco `catch`).
- `saveInServer` com `store.save_return`: `pauseSave() -> store.data = ... -> resumeSave()`.

### Passo 4: Criar suíte de testes em `test/savePause.test.ts`
Implementar testes automatizados para validar a despausa imediata após `nextTick`, incremento de `countChanges` em mutações do consumidor e imunidade a disparos falsos durante cargas internas.

---

## Especificação de Teste TDD (Red-Green)

Criar o arquivo `test/savePause.test.ts` com os seguintes cenários:

1. **Teste Red 1 (Mutação logo após inicialização / microtask):**
   - Setup: Instanciar a store com `isCached = ref(true)`.
   - Ação: Executar `await nextTick()` e realizar `store.data.title = 'Novo Titulo'`. Aguardar `await nextTick()`.
   - Asserção:
     - Com `setTimeout(1)` (*Red*): `store.is_save_in_pause` permanece `true` e `store.countChanges` permanece `0` (falha).
     - Com `nextTick` (*Green*): `store.is_save_in_pause` é `false` e `store.countChanges` incrementa para `1`.

2. **Teste Red 2 (Mutação em `afterLoad` / após `loadInServer`):**
   - Setup: Configurar mock de axios para `axios.get`.
   - Ação: Disparar `loadInServer()`, aguardar resolução da promise, e em seguida alterar `store.data.field = 'alterado'`. Aguardar `await nextTick()`.
   - Asserção: `store.countChanges` incrementa indicando que a mutação pós-carregamento foi detectada e enfileirada para persistência.

3. **Teste Green 3 (Imunidade a falsos positivos durante carga interna):**
   - Setup: Mock de `axios.get` retornando `{ data: { user: 'Max' } }`.
   - Ação: Executar `loadInServer()`, aguardar resolução e processamento de microtasks.
   - Asserção: `store.countChanges` permanece `0` (a carga inicial do servidor não gera loop de auto-salvamento).

4. **Teste Green 4 (Reentrância e aninhamento de `pauseSave`):**
   - Setup: Invocar `pauseSave()` duas vezes consecutivas e depois `resumeSave()`.
   - Asserção: Após o primeiro `nextTick`, `store.is_save_in_pause` permanece `true`. Após o segundo `resumeSave()` e `nextTick`, torna-se `false`.

---

## Banco de dados

**Nenhuma** (Projeto client-side em Vue 3 / Pinia; não requer migrations ou alterações de schema de banco de dados).

---

## Riscos de quebra e Não-Regressão

- **Contrato da API Pública:** O tipo de `is_save_in_pause` permanece `Ref<boolean>` / `boolean`, atendendo à interface declarada em [`src/types.ts:85`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-2/src/types.ts#L85).
- **Sincronização com Vue Reactivity Queue:** Como `nextTick` é enfileirado na mesma microtask queue após a mutação interna de `store.data`, o watcher do Vue processa primeiro a mutação interna com `is_save_in_pause === true` e logo em seguida o callback de `nextTick` restaura `is_save_in_pause = false`. Não há risco de a carga interna disparar salvamento indevido.
- **Compatibilidade com Fake Timers:** Testes que utilizam `vi.useFakeTimers()` passam a funcionar deterministicamente sem necessidade de avançar temporizadores de sistema artificialmente.

---

## Validação

- **Checagem de Tipagem TypeScript:**
  ```bash
  npm run type-check
  ```
- **Execução da Suíte de Testes:**
  ```bash
  npm test
  ```
- Critério de sucesso: 100% dos testes passando sem falhas ou warnings de tipagem.

---

## Skills Aplicáveis

- `systematic-debugging-best-practices`
- `planning-with-files`
- `vue-debugging-best-practices`
- `tdd`
- `superpowers`
- `code-review`
- `production-code-audit`
