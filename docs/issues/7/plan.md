# Plano de Implementação - Issue #7
**Título:** [Audit] Timers de 500ms órfãos sobrescrevem status transitório em requisições simultâneas

---

### Descrição e Causa Raiz

#### Problema Relatado e Agravantes
No arquivo [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts), as propriedades de status transitório (`is_requesting_now` e `is_success_now`) para as quatro operações assíncronas do plugin (`server.get`, `server.save`, `cache.get` e `cache.save`) são observadas por watchers dedicados. Cada watcher espelha os valores de `is_requesting` e `is_success` nas variáveis transitórias e agenda um `setTimeout` fixo de 500ms para redefini-las para `false`.

Contudo, os identificadores retornados por `setTimeout` não são armazenados, não existe chamada a `clearTimeout` antes de novos disparos e nenhum mecanismo de cancelamento no ciclo de vida (descarte de escopo, `$dispose` ou desativação de store) foi configurado.

**Agravantes:**
1. **Sobrescrita Prematura do Status Transitório em Requisições Concorrentes/Sucessivas (Race Condition):**
   Se uma primeira operação inicia em $t = 0\text{ms}$ e uma segunda operação inicia em $t = 200\text{ms}$, o primeiro timer dispara em $t = 500\text{ms}$ e força `is_requesting_now = false` e `is_success_now = false` prematuramente (200ms antes do encerramento da janela devida da segunda requisição), enquanto a segunda requisição ainda está ativa no servidor. A interface de usuário (UI) que consome `is_requesting_now` (ex.: botões com loading, spinners, badges de sincronização) esconde o indicador de carregamento prematuramente, transmitindo a falsa impressão de que a operação foi finalizada.
2. **Timers Órfãos e Vazamento de Memória no Descarte da Store / Componente (Memory Leak):**
   Se a store ou o componente que a utiliza for destruído / desmontado antes de esgotados os 500ms (`store.$dispose()`, `scope.stop()` ou desmonte de componente Vue), os callbacks de `setTimeout` continuam enfileirados no event loop do JavaScript como tarefas órfãs. A closure de cada timer retém referências ao objeto reativo `status`, à store e ao escopo do plugin, impedindo que o Garbage Collector colete esses objetos.
3. **Mutações Fantasmas e Emissão Indevida de Eventos Globais:**
   Quando os timers órfãos disparam após o descarte ou reset da store, eles executam mutações diretas em `status.value`. O watcher global `watch(status, () => document.dispatchEvent(new CustomEvent('status-updated', ...)))` em [`src/plugin.ts:126-129`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts#L126-L129) reage a essas mutações tardias, disparando eventos espúrios no nó raiz `document` para stores já inexistentes ou desativadas.
4. **Ausência de Limpeza em Mudança de Configuração ou Desativação (`status.reset()` / `store.enabled = false`):**
   Quando a store é desativada (`store.enabled = false`) ou reconfigurada (`watch(() => [store.id, store.enabled, store.options?.enabled])` em [`src/plugin.ts:493-509`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts#L493-L509)), `status.reset()` restaura o estado inicial, porém timers agendados anteriormente continuam executando e sobrescrevem as propriedades de status após o reset.
5. **Agendamento Desnecessário de Timers para Estados Já Negativos:**
   Quando tanto `is_requesting` quanto `is_success` são `false` (ex.: após uma falha ou transição de reset), o watcher dispara um `setTimeout` de 500ms inútil apenas para definir como `false` variáveis que já são `false`.

---

#### Causa Raiz Comprovada
- **Localização Exata:** [`src/plugin.ts:L134-168`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts#L134-L168)
- **Trecho de Código Vulnerável:**
  ```typescript
  134:     watch(() => [status.value.server.get.is_requesting, status.value.server.get.is_success], () => {
  135:         status.value.server.get.is_requesting_now = status.value.server.get.is_requesting;
  136:         status.value.server.get.is_success_now = status.value.server.get.is_success;
  137:         setTimeout(() => {
  138:             status.value.server.get.is_requesting_now = false;
  139:             status.value.server.get.is_success_now = false;
  140:         }, 500);
  141:     });
  142: 
  143:     watch(() => [status.value.server.save.is_requesting, status.value.server.save.is_success], () => {
  144:         status.value.server.save.is_requesting_now = status.value.server.save.is_requesting;
  145:         status.value.server.save.is_success_now = status.value.server.save.is_success;
  146:         setTimeout(() => {
  147:             status.value.server.save.is_requesting_now = false;
  148:             status.value.server.save.is_success_now = false;
  149:         }, 500);
  150:     });
  151: 
  152:     watch(() => [status.value.cache.get.is_requesting, status.value.cache.get.is_success], () => {
  153:         status.value.cache.get.is_requesting_now = status.value.cache.get.is_requesting;
  154:         status.value.cache.get.is_success_now = status.value.cache.get.is_success;
  155:         setTimeout(() => {
  156:             status.value.cache.get.is_requesting_now = false;
  157:             status.value.cache.get.is_success_now = false;
  158:         }, 500);
  159:     });
  160: 
  161:     watch(() => [status.value.cache.save.is_requesting, status.value.cache.save.is_success], () => {
  162:         status.value.cache.save.is_requesting_now = status.value.cache.save.is_requesting;
  163:         status.value.cache.save.is_success_now = status.value.cache.save.is_success;
  164:         setTimeout(() => {
  165:             status.value.cache.save.is_requesting_now = false;
  166:             status.value.cache.save.is_success_now = false;
  167:         }, 500);
  168:     });
  ```

- **Fluxo Causal e Rastreamento Reverso de Dados:**
  1. **UI ⇄ Store:** Um componente Vue consome `store.status.server.get.is_requesting_now` diretamente ou via [`useAsyncStatus()`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts#L517-L531) para exibir feedback visual de requisição ativa.
  2. **Store Plugin (`src/plugin.ts:236`):** Em $t = 0\text{ms}$, uma requisição é disparada (`loadInServer()`), definindo `status.value.server.get.is_requesting = true`.
  3. **Watcher Transitório (`src/plugin.ts:134-141`):** O watcher reage, atribui `is_requesting_now = true` e agenda Timer T1 para $t = 500\text{ms}$ sem reter o handle.
  4. **Segunda Operação em $t = 200\text{ms}$ (`src/plugin.ts:282`):** Uma segunda busca ou recarregamento (`reload()`) é acionada. O watcher reage e agenda Timer T2 para $t = 700\text{ms}$. Como T1 não foi cancelado, ambos coexistem no event loop.
  5. **Disparo Prematuro ($t = 500\text{ms}$):** Timer T1 expira e executa `status.value.server.get.is_requesting_now = false`. A UI oculta o indicador de carregamento imediatamente, embora a segunda requisição continue em andamento no servidor até $t = 700\text{ms}$ ou mais.
  6. **Descarte da Store / Event Loop:** Caso a store seja descartada (`store.$dispose()`), os callbacks agendados continuam no runtime e, ao disparar, mutam `status.value`, propagando eventos globais `status-updated` desnecessários via `document.dispatchEvent`.

---

### Arquivos afetados

1. [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts):
   - Adicionar controle explícito de temporizadores transitórios (`timer_server_get`, `timer_server_save`, `timer_cache_get`, `timer_cache_save` tipados como `ReturnType<typeof setTimeout> | null`).
   - Implementar função de limpeza unificada `clearStatusTimers()`.
   - Refatorar os quatro watchers transitórios para:
     - Cancelar timer anterior pendente com `clearTimeout` antes de iniciar novo ciclo.
     - Registrar o cancelamento no callback `onCleanup` do `watch`.
     - Agendar o `setTimeout` de 500ms apenas se `is_requesting` ou `is_success` for `true`.
     - Anular o handle correspondente (`timer = null`) no término da execução do callback do timer.
   - Invocar `clearStatusTimers()` em:
     - Reconfiguração/desativação da store (`watch(() => [store.id, store.enabled, store.options?.enabled])`).
     - Descarte da store (`store.$dispose()`).
     - Descarte do escopo reativo (`onScopeDispose` quando `getCurrentScope()` estiver ativo).
2. [`test/statusTimers.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/test/statusTimers.test.ts) (Novo arquivo de testes):
   - Cobertura completa de testes automatizados com `vi.useFakeTimers()` para validar:
     - Não-sobrescrita de status em requisições consecutivas dentro de 500ms.
     - Cancelamento e descarte definitivo de timers ao chamar `store.$dispose()`.
     - Cancelamento de timers ao desativar a store (`store.enabled = false`).
     - Comportamento idêntico nos 4 canais (`server.get`, `server.save`, `cache.get`, `cache.save`).
     - Não agendamento de temporizador quando ambos os estados forem `false`.

---

### Execuções propostas

#### 1. Declaração dos Handles e Função de Limpeza em [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts)
No escopo de `maxPiniaPlugin`, logo após a criação da ref `status`:
```typescript
let timer_server_get: ReturnType<typeof setTimeout> | null = null;
let timer_server_save: ReturnType<typeof setTimeout> | null = null;
let timer_cache_get: ReturnType<typeof setTimeout> | null = null;
let timer_cache_save: ReturnType<typeof setTimeout> | null = null;

const clearStatusTimers = () => {
    if (timer_server_get) {
        clearTimeout(timer_server_get);
        timer_server_get = null;
    }
    if (timer_server_save) {
        clearTimeout(timer_server_save);
        timer_server_save = null;
    }
    if (timer_cache_get) {
        clearTimeout(timer_cache_get);
        timer_cache_get = null;
    }
    if (timer_cache_save) {
        clearTimeout(timer_cache_save);
        timer_cache_save = null;
    }
};
```

#### 2. Refatoração dos 4 Watchers Transitórios em [`src/plugin.ts:134-168`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/plugin.ts#L134-L168)
Substituir os blocos anônimos por lógica que cancela timers pendentes e só agenda novos quando necessário:
```typescript
watch(() => [status.value.server.get.is_requesting, status.value.server.get.is_success], ([isReq, isSuccess], _, onCleanup) => {
    if (timer_server_get) {
        clearTimeout(timer_server_get);
        timer_server_get = null;
    }
    status.value.server.get.is_requesting_now = isReq;
    status.value.server.get.is_success_now = isSuccess;
    if (isReq || isSuccess) {
        timer_server_get = setTimeout(() => {
            status.value.server.get.is_requesting_now = false;
            status.value.server.get.is_success_now = false;
            timer_server_get = null;
        }, 500);
        onCleanup(() => {
            if (timer_server_get) {
                clearTimeout(timer_server_get);
                timer_server_get = null;
            }
        });
    }
});

watch(() => [status.value.server.save.is_requesting, status.value.server.save.is_success], ([isReq, isSuccess], _, onCleanup) => {
    if (timer_server_save) {
        clearTimeout(timer_server_save);
        timer_server_save = null;
    }
    status.value.server.save.is_requesting_now = isReq;
    status.value.server.save.is_success_now = isSuccess;
    if (isReq || isSuccess) {
        timer_server_save = setTimeout(() => {
            status.value.server.save.is_requesting_now = false;
            status.value.server.save.is_success_now = false;
            timer_server_save = null;
        }, 500);
        onCleanup(() => {
            if (timer_server_save) {
                clearTimeout(timer_server_save);
                timer_server_save = null;
            }
        });
    }
});

watch(() => [status.value.cache.get.is_requesting, status.value.cache.get.is_success], ([isReq, isSuccess], _, onCleanup) => {
    if (timer_cache_get) {
        clearTimeout(timer_cache_get);
        timer_cache_get = null;
    }
    status.value.cache.get.is_requesting_now = isReq;
    status.value.cache.get.is_success_now = isSuccess;
    if (isReq || isSuccess) {
        timer_cache_get = setTimeout(() => {
            status.value.cache.get.is_requesting_now = false;
            status.value.cache.get.is_success_now = false;
            timer_cache_get = null;
        }, 500);
        onCleanup(() => {
            if (timer_cache_get) {
                clearTimeout(timer_cache_get);
                timer_cache_get = null;
            }
        });
    }
});

watch(() => [status.value.cache.save.is_requesting, status.value.cache.save.is_success], ([isReq, isSuccess], _, onCleanup) => {
    if (timer_cache_save) {
        clearTimeout(timer_cache_save);
        timer_cache_save = null;
    }
    status.value.cache.save.is_requesting_now = isReq;
    status.value.cache.save.is_success_now = isSuccess;
    if (isReq || isSuccess) {
        timer_cache_save = setTimeout(() => {
            status.value.cache.save.is_requesting_now = false;
            status.value.cache.save.is_success_now = false;
            timer_cache_save = null;
        }, 500);
        onCleanup(() => {
            if (timer_cache_save) {
                clearTimeout(timer_cache_save);
                timer_cache_save = null;
            }
        });
    }
});
```

#### 3. Limpeza de Timers no Ciclo de Vida da Store e do Escopo
1. **No watcher de configuração (`src/plugin.ts:493-509`):**
   ```typescript
   watch(() => [store.id, store.enabled, store.options?.enabled], () => {
       idx.value = store.id;
       pauseSave();
       setDefaultData();
       resumeSave();
       clearStatusTimers();
       status.reset();
       if (store.enabled === false || store.options?.enabled === false) {
           if (cancel_timer) {
               clearTimeout(cancel_timer);
               cancel_timer = null;
               is_cancelling.value = false;
           }
           if (signal_get_request.value) signal_get_request.value.abort();
           return;
       }
       loadInCache();
   }, { immediate: true });
   ```

2. **No método `$dispose` da store:**
   Interceptar `$dispose` para garantir que o descarte da store limpe todos os timers pendentes:
   ```typescript
   const originalDispose = store.$dispose.bind(store);
   store.$dispose = () => {
       clearStatusTimers();
       originalDispose();
   };
   ```

3. **No hook `onScopeDispose` (se escopo reativo existir):**
   ```typescript
   if (getCurrentScope()) {
       onScopeDispose(() => {
           clearStatusTimers();
       });
   }
   ```

---

### Especificação de Teste TDD (Red-Green)

Criar o arquivo de testes [`test/statusTimers.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/test/statusTimers.test.ts) com Vitest e fake timers (`vi.useFakeTimers()`).

#### Cenário 1: Requisições consecutivas/simultâneas dentro da janela de 500ms não sobrescrevem status prematuramente (Red -> Green)
- **Setup:**
  Mock de `axios.get` que retorna promises pendentes controladas individualmente para requisição 1 e requisição 2.
- **Passos:**
  1. Store é inicializada em $t = 0\text{ms}$ e dispara a primeira busca via `loadInServer()`.
  2. Em $t = 10\text{ms}$, asserção: `status.server.get.is_requesting === true` e `status.server.get.is_requesting_now === true`.
  3. Em $t = 200\text{ms}$, dispara-se uma segunda requisição via `store.reload()`.
  4. Em $t = 210\text{ms}$, asserção: `status.server.get.is_requesting === true` e `status.server.get.is_requesting_now === true`.
  5. Avançar o tempo em 290ms até $t = 500\text{ms}$ (instante em que o timer da requisição 1 expirava no código legado).
  6. **Asserção Red -> Green:**
     - *Comportamento Red (código atual):* `status.server.get.is_requesting_now` se torna `false` prematuramente aos 500ms.
     - *Comportamento Green (após correção):* `status.server.get.is_requesting_now` **permanece `true`** aos 500ms porque o timer anterior foi cancelado.
  7. Avançar mais 210ms até $t = 710\text{ms}$ (500ms após a segunda requisição):
     - `status.server.get.is_requesting_now` agora transita para `false` no momento exato devido à segunda requisição.

#### Cenário 2: Cancelamento de timers ao descartar a store via `store.$dispose()` (Memory Leak Prevention)
- **Setup:**
  Espionar `document.dispatchEvent` com `vi.spyOn(document, 'dispatchEvent')`.
- **Passos:**
  1. Disparar uma operação (`status.server.get.is_requesting = true`), iniciando um timer de 500ms.
  2. Em $t = 100\text{ms}$, chamar `store.$dispose()`.
  3. Limpar histórico de chamadas do spy.
  4. Avançar o tempo em 1000ms (`vi.advanceTimersByTimeAsync(1000)`).
  5. **Asserção:**
     - Nenhum evento `status-updated` é disparado no `document` após o `$dispose()`.
     - Nenhuma mutação tardia ocorre no objeto `status`.

#### Cenário 3: Cancelamento de timers ao desativar a store (`store.enabled = false`)
- **Passos:**
  1. Disparar requisição em store ativa com timer de 500ms em andamento.
  2. Alterar `store.enabled = false`.
  3. Avançar 1000ms.
  4. **Asserção:**
     - O estado inicial foi restaurado via `status.reset()`.
     - Nenhum timer pendente executa para mutar `status.value` após a desativação.

#### Cenário 4: Validação dos canais `server.save`, `cache.get` e `cache.save`
- **Passos:**
  - Repetir o teste de sobreposição temporal de operações para `server.save`, `cache.get` e `cache.save`.
  - Garantir que todas as 4 operações se comportam de forma idêntica e consistente.

#### Cenário 5: Transição para `false/false` não agenda novo timer
- **Passos:**
  - Espionar `setTimeout` com `vi.spyOn(globalThis, 'setTimeout')`.
  - Simular erro na operação (`is_requesting = false, is_success = false`).
  - **Asserção:**
    - Nenhum novo temporizador é agendado no event loop.

---

### Banco de dados

**Nenhuma** migration ou alteração estrutural no banco de dados necessária (biblioteca cliente front-end / plugin Pinia).

---

### Riscos de quebra e Não-Regressão

- **Compatibilidade de Contrato de API:** Nenhuma quebra de contrato. A interface pública [`Status`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/types.ts#L17-L20), os tipos [`OperationStatus`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-7/src/types.ts#L5-L14) e as funções exportadas permanecem 100% idênticas e retrocompatíveis.
- **Isolamento de Efeitos Colaterais:** A limpeza explícita dos temporizadores previne que closures fiquem presas no event loop, sem alterar o tempo de 500ms das requisições isoladas.
- **Suíte de Testes Existente (Não-Regressão):**
  - Toda a suíte existente de 84 testes (em `test/autosave.test.ts`, `test/buildUrl.test.ts`, `test/cancelLoad.test.ts`, `test/config.test.ts`, `test/deduplication.test.ts`, `test/internal.test.ts`, `test/savePause.test.ts` e `test/useAsyncStatus.test.ts`) deve continuar passando com 100% de sucesso.

---

### Validação

Execução dos comandos automatizados no terminal:
```bash
npm run type-check && npm test && npm run build
```

**Critérios de Sucesso:**
1. `npm run type-check` (`vue-tsc --noEmit`) conclui com 0 erros de tipagem.
2. `npm test` (`vitest run`) aprova 100% dos testes em todos os arquivos da suíte (8 arquivos existentes + o novo `test/statusTimers.test.ts`).
3. `npm run build` compila o pacote de distribuição (`dist/index.es.js` e `dist/index.d.ts`) sem erros nem alertas.

---

### Skills Aplicáveis

- `systematic-debugging-best-practices`
- `vue-debugging-best-practices`
- `tdd`
- `planning-with-files`
- `code-review`
- `production-code-audit`
