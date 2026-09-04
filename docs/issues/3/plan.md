# Plano de Implementação - Issue #3
**Título:** [Audit] Acúmulo de timers não cancelados e requisições órfãs em cancelLoad

---

### Descrição e Causa Raiz

#### Problema e Agravantes
No plugin principal (`src/plugin.ts`), o método `cancelLoad(retryInSeconds)` provê um mecanismo para abortar a requisição atual de carregamento (`GET`) em andamento e, opcionalmente, reagendar uma nova tentativa após determinado número de segundos (`retryInSeconds`).

No entanto, o timer retornado pela função `setTimeout` não é armazenado em nenhuma variável nem limpo via `clearTimeout`. Isso gera os seguintes agravantes em cenários reais da aplicação:
1. **Disparo de requisições concorrentes duplicadas/órfãs:** Se `cancelLoad(5)` for invocado e, pouco depois, `cancelLoad(10)` for chamado, o primeiro timer de 5s não é cancelado. Aos 5 segundos, o primeiro timer dispara `loadInServer()`, e aos 10 segundos o segundo timer dispara uma nova requisição `loadInServer()`.
2. **Inconsistência da flag `is_cancelling`:** O primeiro timer a expirar define `is_cancelling.value = false`, anulando prematuramente o estado de cancelamento enquanto o segundo timer de 10s ainda deveria manter o cancelamento ativo.
3. **Impossibilidade de cancelamento definitivo:** Se um reagendamento foi iniciado via `cancelLoad(5)` e posteriormente a aplicação chama `cancelLoad()` (sem parâmetros ou com `null`/`false`) para cancelar de vez o carregamento, o timer de 5s continua ativo e disparará `loadInServer()` mesmo contra a vontade do consumidor.
4. **Vazamento de timer e execuções com Store Desativada:** Se a store for desativada (`store.enabled = false`) ou reconfigurada antes do timer disparar, o timer permanece agendado no runtime Javascript (memory leak / closure leak).

#### Causa Raiz Comprovada
- **Arquivo e Linha Exatos:** [`src/plugin.ts:L200-212`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-3/src/plugin.ts#L200-L212)
```typescript
200:     const is_cancelling = ref(false);
201:     const cancelLoad = (retryInSeconds: number | boolean | null = null) => {
202:         if (signal_get_request.value) signal_get_request.value.abort();
203:         if (retryInSeconds === true || retryInSeconds === 0) retryInSeconds = 5;
204:         const seconds = Number(retryInSeconds);
205:         if (seconds > 0) {
206:             is_cancelling.value = true;
207:             setTimeout(() => {
208:                 is_cancelling.value = false;
209:                 loadInServer().then();
210:             }, seconds * 1000);
211:         }
212:     };
```

- **Fluxo Causal e Rastreamento Reverso:**
  1. **UI / Componente:** Componente Vue chama `store.cancelLoad(5)` para adiar busca e logo em seguida `store.cancelLoad(10)` ou `store.cancelLoad()`.
  2. **Store Plugin (`src/plugin.ts:201`):** `cancelLoad` aborta o `signal_get_request` ativo, mas omite o rastreamento e cancelamento de `cancel_timer` (`clearTimeout`).
  3. **Event Loop / Timers:** Dois (ou mais) timers ficam ativos em paralelo no microtask/macrotask queue do Node/Browser.
  4. **Execução Prematura / Concorrente:** O timer anterior expira, reseta `is_cancelling.value = false` e invoca `loadInServer()`.
  5. **API / Rotas (`axios.get`):** Múltiplas chamadas HTTP desnecessárias atingem o backend com sobrecarga e risco de race conditions na reatividade de `store.data`.

---

### Arquivos afetados

1. [`src/plugin.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-3/src/plugin.ts):
   - Adicionar controle de handle de timer (`cancel_timer: ReturnType<typeof setTimeout> | null`).
   - Limpar timer anterior sempre que `cancelLoad()` for chamado ou quando a store for desativada (`store.enabled === false`).
   - Garantir que `cancelLoad()` sem retry limpe o timer pendente e redefina `is_cancelling.value = false`.
2. [`test/cancelLoad.test.ts`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-3/test/cancelLoad.test.ts) (Novo arquivo de testes):
   - Cobertura de testes unitários com fake timers (`vi.useFakeTimers()`) para `cancelLoad` (abort de requisição em voo, substituição de timers, cancelamento definitivo e teardown/desativação).

---

### Execuções propostas

1. **Armazenamento e Limpeza do Handle de Timer em `src/plugin.ts`:**
   - Declarar no escopo da store do plugin:
     ```typescript
     let cancel_timer: ReturnType<typeof setTimeout> | null = null;
     ```
   - Atualizar a função `cancelLoad`:
     ```typescript
     const cancelLoad = (retryInSeconds: number | boolean | null = null) => {
         if (cancel_timer) {
             clearTimeout(cancel_timer);
             cancel_timer = null;
         }
         is_cancelling.value = false;

         if (signal_get_request.value) signal_get_request.value.abort();
         if (retryInSeconds === true || retryInSeconds === 0) retryInSeconds = 5;
         const seconds = Number(retryInSeconds);
         if (seconds > 0) {
             is_cancelling.value = true;
             cancel_timer = setTimeout(() => {
                 cancel_timer = null;
                 is_cancelling.value = false;
                 loadInServer().then();
             }, seconds * 1000);
         }
     };
     ```

2. **Limpeza em Mudança de Estado / Desativação da Store:**
   - No watcher reativo de `[store.id, store.enabled, store.options?.enabled]` (`src/plugin.ts:470`):
     ```typescript
     if (store.enabled === false || store.options?.enabled === false) {
         if (cancel_timer) {
             clearTimeout(cancel_timer);
             cancel_timer = null;
             is_cancelling.value = false;
         }
         if (signal_get_request.value) signal_get_request.value.abort();
         return;
     }
     ```

3. **Criação do Suite de Testes TDD (`test/cancelLoad.test.ts`):**
   - Implementar os cenários de teste automatizado usando Vitest.

---

### Especificação de Teste TDD (Red-Green)

Criar o arquivo `test/cancelLoad.test.ts`:
- **Cenário 1 (Substituição de retry / Timers órfãos):**
  - Chamar `store.cancelLoad(5)`.
  - Em seguida, chamar `store.cancelLoad(10)`.
  - Avançar o tempo em 5000ms (`vi.advanceTimersByTime(5000)`).
  - *Asserção Red:* No código atual, `axios.get` é chamado aos 5s. Com a correção (*Green*), `axios.get` não é chamado aos 5s.
  - Avançar o tempo em mais 5000ms (total 10s).
  - *Asserção:* `axios.get` é chamado exatamente 1 vez aos 10s.
- **Cenário 2 (Cancelamento definitivo sem retry):**
  - Chamar `store.cancelLoad(5)`.
  - Chamar `store.cancelLoad()`.
  - Avançar 10000ms.
  - *Asserção:* Nenhuma chamada `axios.get` é disparada.
- **Cenário 3 (Desativação da store):**
  - Chamar `store.cancelLoad(5)`.
  - Definir `store.enabled = false`.
  - Avançar 5000ms.
  - *Asserção:* Nenhuma requisição executada e timer limpo.
- **Cenário 4 (Abort de requisição ativa):**
  - Disparar `loadInServer()` com requisição pendente.
  - Chamar `store.cancelLoad()`.
  - *Asserção:* `AbortController.abort()` chamado no sinal da requisição.

---

### Banco de dados
Nenhuma.

---

### Riscos de quebra e Não-Regressão
- **Riscos de Contrato:** Nenhum. A assinatura pública da função `cancelLoad(retryInSeconds?: number | boolean | null)` permanece idêntica e 100% retrocompatível com as tipagens em `src/types.ts`.
- **Efeitos Colaterais:** Apenas previne disparos indevidos em segundo plano.
- **Regressão:** Executar toda a suíte existente de testes (`npm test`) para garantir que os testes de `buildUrl`, `config` e `internal` continuem 100% aprovados.

---

### Validação
Execução dos comandos:
```bash
npm run test
npm run type-check
npm run build
```
Critério de sucesso: 100% dos testes passando (incluindo o novo `test/cancelLoad.test.ts`), `vue-tsc` sem erros de tipo e build de produção gerado sem falhas.

---

### Skills Aplicáveis
- `systematic-debugging-best-practices`
- `planning-with-files`
- `vue-debugging-best-practices`
- `tdd`
- `code-review`
- `production-code-audit`
