# Plano de Implementação - Issue #1

## Descrição e Causa Raiz

### Problema Relatado e Agravantes
A função composable `useAsyncStatus()`, exportada como utilitário público em `@maxvue/max-pinia` (`src/index.ts` e `src/plugin.ts`), registra um event listener no DOM global através de `document.addEventListener('status-updated', ...)`. No entanto, ela não associa nenhum gancho de descarte de ciclo de vida (`onScopeDispose` / `tryOnScopeDispose` / `onUnmounted`).

**Agravantes:**
1. **Memory Leak Cumulativo:** Em aplicações SPA (Single Page Applications), componentes Vue que consomem `useAsyncStatus()` montam e desmontam frequentemente (ex.: trocas de rota, modais, tabs, componentes condicionais `v-if`). A cada montagem, um novo listener anônimo é registrado no objeto global `document`.
2. **Retenção de Instâncias Reativas:** A closure da função anônima mantém a referência ao `Ref<Status | null>`, impedindo que o garbage collector colete os objetos reativos e o contexto associado ao componente destruído.
3. **Degradação de Desempenho e Disparos Fantasmas:** A cada disparo do evento `status-updated` por qualquer store (via `document.dispatchEvent`), todos os listeners acumulados e zumbis são executados, reprocessando atualizações para `refs` inativas.

### Causa Raiz Comprovada
- **Localização Exata:** [`src/plugin.ts:486-490`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-1/src/plugin.ts#L486-L490)
- **Trecho de Código Vulnerável:**
  ```ts
  export function useAsyncStatus(): Ref<Status | null> {
      const asyncStatus = ref<Status | null>(null);
      if (typeof document !== 'undefined') document.addEventListener('status-updated', (event: any) => asyncStatus.value = event.detail);
      return asyncStatus;
  }
  ```
- **Fluxo Causal e Rastreamento de Dados:**
  1. **UI / Componente:** Um componente Vue invoca `useAsyncStatus()` durante seu `setup()`.
  2. **Composable:** `useAsyncStatus()` cria `asyncStatus = ref<Status | null>(null)` e anexa uma arrow function anônima via `document.addEventListener('status-updated', ...)`.
  3. **Pinia Store:** Operações assíncronas no plugin (`watch(status, ...)` em [`src/plugin.ts:126-129`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-1/src/plugin.ts#L126-L129)) emitem `CustomEvent('status-updated', { detail: status.value })` no `document`.
  4. **Descarte do Componente:** O componente é destruído (`unmounted` / `scope.stop()`), mas nenhum `removeEventListener` é chamado porque a função era anônima e nenhum gancho de ciclo de vida (`onScopeDispose`) foi configurado.
  5. **Vazamento:** O listener persiste indefinidamente no nó raiz `document`.

---

## Arquivos Afetados

1. `src/plugin.ts` — Importar `getCurrentScope` e `onScopeDispose` (de `vue`) ou usar `tryOnScopeDispose` (de `@vueuse/core`), definir a função nomeada do handler e registrar a remoção do listener no descarte do escopo reativo.
2. `test/useAsyncStatus.test.ts` — Novo arquivo de testes unitários dedicado para validar o comportamento reativo, o descarte correto do listener em `effectScope` e a ausência de vazamento de memória.

---

## Execuções Propostas

### 1. Ajuste em `src/plugin.ts`
- Importar `getCurrentScope` e `onScopeDispose` de `vue` (ou `tryOnScopeDispose` de `@vueuse/core`).
- Refatorar `useAsyncStatus()` para:
  1. Criar uma referência estável para a função de callback (`handler`).
  2. Anexar o listener com `document.addEventListener('status-updated', handler)`.
  3. Verificar se existe um escopo reativo ativo (`getCurrentScope()`) e, havendo, registrar `onScopeDispose(() => { document.removeEventListener('status-updated', handler); })`.
  4. Garantir que, se chamado fora de um escopo reativo, continue funcionando normalmente sem lançar exceções.

```ts
export function useAsyncStatus(): Ref<Status | null> {
    const asyncStatus = ref<Status | null>(null);
    if (typeof document !== 'undefined') {
        const handler = (event: Event) => {
            asyncStatus.value = (event as CustomEvent<Status>).detail;
        };
        document.addEventListener('status-updated', handler);
        if (getCurrentScope()) {
            onScopeDispose(() => {
                document.removeEventListener('status-updated', handler);
            });
        }
    }
    return asyncStatus;
}
```

---

## Especificação de Teste TDD (Red-Green)

### Criação de `test/useAsyncStatus.test.ts`

O teste automatizado deve cobrir os seguintes cenários:

1. **Cenário 1: Reatividade e atualização básica**
   - Chamar `useAsyncStatus()`.
   - Disparar um `CustomEvent('status-updated', { detail: mockStatus })` no `document`.
   - Validar que `asyncStatus.value` é atualizado com `mockStatus`.

2. **Cenário 2: Descarte de listener no ciclo de vida (Red -> Green)**
   - Executar `useAsyncStatus()` dentro de um `effectScope()` do Vue.
   - Espionar `document.removeEventListener`.
   - Finalizar o escopo via `scope.stop()`.
   - Validar que `document.removeEventListener('status-updated', handler)` foi chamado exatamente 1 vez.
   - Disparar um novo evento `status-updated` no `document` e verificar que o `asyncStatus` anterior não é mais modificado.

3. **Cenário 3: Execução segura fora de escopo reativo**
   - Executar `useAsyncStatus()` fora de qualquer `effectScope` ou componente.
   - Garantir que não lança erro e continua respondendo a eventos enquanto o documento existir.

4. **Cenário 4: Prevenção de acúmulo em múltiplos ciclos de montagem/desmontagem**
   - Simular N ciclos de criação e destruição de `effectScope` com `useAsyncStatus()`.
   - Verificar que a cada descarte o listener correspondente é removido, mantendo apenas os listeners dos escopos ativos.

---

## Banco de Dados

**Nenhuma** migration ou alteração de banco de dados necessária (biblioteca cliente front-end / plugin Pinia).

---

## Riscos de Quebra e Não-Regressão

- **Compatibilidade de API:** Nenhuma quebra de contrato. A assinatura e o tipo de retorno `useAsyncStatus(): Ref<Status | null>` permanecem idênticos.
- **Ambiente SSR (Server-Side Rendering):** Mantida a verificação `typeof document !== 'undefined'`, garantindo que em ambientes SSR/Node não ocorram falhas.
- **Não-Regressão:** A suite existente de testes (`test/buildUrl.test.ts`, `test/config.test.ts`, `test/internal.test.ts`) deve continuar com 100% de aprovação.

---

## Validação

Comando automatizado de validação completa:
```bash
npm run type-check && npm test
```
Critérios de sucesso:
- `vue-tsc --noEmit` executa sem nenhum erro de tipagem.
- Todos os testes unitários (incluindo o novo `test/useAsyncStatus.test.ts`) passam com sucesso.

---

## Skills Aplicáveis

- `systematic-debugging-best-practices`
- `vue-debugging-best-practices`
- `tdd`
- `planning-with-files`
- `code-review`
- `production-code-audit`
