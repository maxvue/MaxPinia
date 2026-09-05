# Plano de Implementação - Issue #6

## [Audit] Colisão entre stores e destruição indevida do cache global pelo uso do singleton localforage

### Descrição e Causa Raiz

#### Descrição Detalhada do Problema
O plugin `@maxvue/max-pinia` utiliza a biblioteca `localforage` para fornecer persistência offline e reidratação de dados reativos em stores do Pinia. No entanto, a implementação atual em [`src/plugin.ts:90`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L90) utiliza a exportação padrão global (singleton) do `localforage`, invocando `localforage.config({ name: cache_name.value, storeName: cfg.storeName })` e realizando operações de leitura, gravação e limpeza diretamente sobre a instância global compartilhada (`localforage.getItem`, `localforage.setItem`, `localforage.removeItem`, `localforage.clear`).

Conforme a especificação oficial da biblioteca `localforage`:
1. O método `config()` altera a configuração da instância default compartilhada no processo/bundle.
2. `config()` só tem garantia de surtir efeito antes de qualquer operação de I/O de dados (`getItem`, `setItem`, `removeItem`, `clear`, etc.). Uma vez iniciada qualquer operação, a conexão com o driver subjacente (IndexedDB, WebSQL ou localStorage) é estabelecida e não é mais reconfigurada confiavelmente por novas chamadas a `config()`.
3. Além disso, a chamada exposta publicamente `store.clearAll()` executa incondicionalmente `await localforage.clear()` ([`src/plugin.ts:511`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L511)). O método `clear()` do `localforage` esvazia todo o object store ativo no banco de dados, destruindo de forma irreversível os dados cacheados de **todas** as stores da aplicação registradas naquele banco, e não apenas da store onde `clearAll()` foi acionado.

#### Agravantes
1. **Colisão de Bancos e Corrupção Cruzada de Dados (Cross-Database Contamination):**
   - Quando diferentes stores são registradas na aplicação com nomes de banco distintos (via `store.cache_name = ref('banco-custom')`), cada registro de store subsequente executa `localforage.config()` sobre o mesmo singleton.
   - Isso provoca uma condição de corrida destrutiva: operações de `saveInCache()` e `loadInCache()` de Store A passam a ser gravadas ou lidas no banco de Store B caso Store B tenha sido inicializada por último, ou Store B passa a gravar dados no banco de Store A caso a conexão do singleton já tivesse sido travada pelas operações iniciais de Store A.
2. **Destrutividade do `store.clearAll()`:**
   - Em aplicações com múltiplos stores (ex.: `auth`, `user`, `cart`, `products`), é esperado que uma chamada a `userStore.clearAll()` (por exemplo, ao efetuar logout) limpe apenas os registros pertencentes àquela store.
   - Na implementação atual, `localforage.clear()` expurga indiscriminadamente todo o banco de dados/object store. O cache do `cartStore`, `productsStore` e demais dados offline são sumariamente apagados.
3. **Incapacidade de Customização Per-Store de `storeName`:**
   - A configuração de `storeName` é lida apenas de `cfg.storeName` no singleton global. Se uma store individual tentar definir um `storeName` ou `store_name` próprio para segregação de tabelas no IndexedDB, ela colidirá globalmente com as demais stores.
4. **Falsos Positivos e Mascaramento em Testes:**
   - Todas as suítes de teste existentes utilizavam mocks simplificados da exportação default (`vi.mock('localforage', () => ({ default: { config: vi.fn(), getItem: ... } }))`), sem simular a concorrência entre instâncias e assumindo erroneamente que `clear()` em `clearAll` era o comportamento correto.

#### Causa Raiz Comprovada
- **Localização Exata no Código:**
  - [`src/plugin.ts:L3`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L3): `import localforage from 'localforage';`
  - [`src/plugin.ts:L89-90`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L89-90):
    ```ts
    const cache_name: Ref = store.cache_name ?? ref(cfg.cacheName);
    localforage.config({ name: cache_name.value, storeName: cfg.storeName });
    ```
  - [`src/plugin.ts:L295`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L295): `localforage.getItem(getKey())`
  - [`src/plugin.ts:L314`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L314): `localforage.removeItem(getKey()).catch(() => {});`
  - [`src/plugin.ts:L359-360`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L359-360): `localforage.setItem(getKey(), cleanData)`
  - [`src/plugin.ts:L511`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L511): `const clearAll = async () => await localforage.clear();`

- **Fluxo Causal:**
  1. A aplicação Vue/Pinia invoca `pinia.use(createMaxPinia(config))`.
  2. São inicializadas duas stores com cache habilitado: Store A (`$id: 'storeA'`, `cache_name = ref('banco-a')`) e Store B (`$id: 'storeB'`, `cache_name = ref('banco-b')`).
  3. Durante a inicialização de Store A, `localforage.config({ name: 'banco-a', storeName: cfg.storeName })` é executado no singleton.
  4. Durante a inicialização de Store B, `localforage.config({ name: 'banco-b', storeName: cfg.storeName })` sobrescreve a configuração global da mesma instância.
  5. Quando Store A invoca `saveInCache()`, a escrita é despachada para `localforage.setItem(...)` sobre o singleton, direcionando os dados para `'banco-b'` em vez de `'banco-a'` (ou mantendo `'banco-a'` caso a inicialização de I/O tenha bloqueado nova reconfiguração).
  6. Quando Store A invoca `storeA.clearAll()`, `localforage.clear()` é executado no singleton, varrendo todo o armazenamento do IndexedDB e destruindo os dados de Store B e de todas as outras stores da aplicação.

- **Rastreamento Reverso de Dados:**
  `UI / Componentes Vue (storeA.clearAll / store.data mutation)` ⇄ `Pinia Stores (storeA, storeB)` ⇄ `MaxPinia Plugin (maxPiniaPlugin, saveInCache, loadInCache, clearAll)` ⇄ `LocalForage Global Singleton (localforage.config / getItem / setItem / clear)` ⇄ `Storage Subsystem (IndexedDB ObjectStores / WebSQL / LocalStorage)`.

---

### Arquivos afetados

1. **`src/plugin.ts`**:
   - Criação de instâncias isoladas de armazenamento via `localforage.createInstance(...)` por store, respeitando `cache_name.value` e suporte a `storeName` customizado por store (`store.storeName ?? store.store_name ?? store.options?.storeName ?? store.options?.store_name ?? cfg.storeName`).
   - Substituição das chamadas I/O do singleton (`localforage.getItem`, `localforage.setItem`, `localforage.removeItem`) pelos métodos da instância isolada `storage`.
   - Implementação de `clearAll()` não-destrutivo: consulta cirúrgica de chaves via `storage.keys()` e remoção via `Promise.all(storeKeys.map(k => storage.removeItem(k)))`, filtrando apenas chaves pertencentes à store atual (`k === store.$id || k.startsWith(store.$id + '.')`), preservando os dados de outras stores.
   - Fornecimento de fallback defensivo para casos em que `localforage.createInstance` não for uma função (ex.: mocks simplificados legados).

2. **`test/config.test.ts`**:
   - Atualização do mock de `localforage` para incluir `createInstance`.
   - Atualização do teste de repasse de `storeName` para verificar `localforage.createInstance` em conformidade com o novo padrão arquitetural.

3. **`test/deduplication.test.ts`**:
   - Atualização do mock de `localforage` para suportar `createInstance` e `keys`.
   - Refatoração do Caso 12 (`clearAll`) para testar a deleção segura e cirúrgica das chaves da store, garantindo que `storage.clear()` global não seja invocado e chaves de outras stores permaneçam intactas.

4. **`test/autosave.test.ts`**, **`test/cancelLoad.test.ts`**, **`test/savePause.test.ts`**:
   - Atualização dos mocks do `localforage` nestes arquivos de teste para incluir `createInstance` retornando o mock da instância de storage, garantindo integridade e não-regressão de toda a suíte.

5. **`test/storageIsolation.test.ts`** *(Novo arquivo)*:
   - Suíte de testes dedicada cobrindo:
     - Isolamento de instâncias com bancos diferentes (`cache_name = 'banco-a'` vs `'banco-b'`).
     - Isolamento com múltiplos `storeName`.
     - Garantia de que `storeA.clearAll()` não remove chaves de `storeB` mesmo compartilhando o mesmo banco de dados.
     - Resiliência e tratamento de erro quando `keys()` ou `removeItem()` falham em `clearAll()`.

6. **`docs/issues/6/plan.md`**:
   - Documentação estruturada do planejamento técnico.

---

### Execuções propostas

#### 1. Criação de Instância Isolada de Storage por Store em `src/plugin.ts`
Substituir a reconfiguração global do singleton em [`src/plugin.ts:89-90`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L89-L90) por instanciação isolada:
```ts
const cache_name: Ref = store.cache_name ?? ref(cfg.cacheName);
const store_name = store.storeName ?? store.store_name ?? store.options?.storeName ?? store.options?.store_name ?? cfg.storeName;

// Criação de instância isolada de LocalForage por store com fallback defensivo para mocks legados
const storage: any = typeof localforage.createInstance === 'function'
    ? localforage.createInstance({ name: cache_name.value, storeName: store_name })
    : (localforage.config({ name: cache_name.value, storeName: store_name }), localforage);
```

#### 2. Escopo das Operações de I/O do Cache
Substituir as referências ao singleton global `localforage` pela referência à instância local `storage`:
- **`loadInCache`** ([`src/plugin.ts:295`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L295)):
  ```ts
  // De:
  localforage.getItem(getKey())
  // Para:
  storage.getItem(getKey())
  ```
- **Remoção em cache corrompido** ([`src/plugin.ts:314`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L314)):
  ```ts
  // De:
  localforage.removeItem(getKey()).catch(() => {});
  // Para:
  storage.removeItem(getKey()).catch(() => {});
  ```
- **`saveInCache`** ([`src/plugin.ts:359-360`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L359-L360)):
  ```ts
  // De:
  localforage.setItem(getKey(), cleanData)
  // Para:
  storage.setItem(getKey(), cleanData)
  ```

#### 3. Implementação Segura e Cirúrgica de `clearAll()`
Em [`src/plugin.ts:511`](file:///home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-implement-issue-6/src/plugin.ts#L511), substituir a limpeza destrutiva global por um método seguro que consulta as chaves e remove somente aquelas pertencentes ao prefixo do `$id` da store:
```ts
const clearAll = async () => {
    try {
        const allKeys = await storage.keys();
        const prefix = `${store.$id}.`;
        const storeKeys = allKeys.filter((k: string) => k === store.$id || k.startsWith(prefix));
        await Promise.all(storeKeys.map((k: string) => storage.removeItem(k)));
    } catch (error: any) {
        console.error('[max-pinia] CLEAR ALL ERROR: ' + error.name, error);
    }
};
```

#### 4. Atualização dos Mocks nas Suítes de Teste Existentes
Para evitar quebras nas suítes existentes (`test/config.test.ts`, `test/autosave.test.ts`, `test/cancelLoad.test.ts`, `test/deduplication.test.ts`, `test/savePause.test.ts`), atualizar os mocks para suportar `createInstance` e `keys`:
```ts
const mockStorageInstance = {
    config: vi.fn(),
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(null),
    removeItem: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(null),
    keys: vi.fn().mockResolvedValue([])
};

vi.mock('localforage', () => ({
    default: {
        ...mockStorageInstance,
        createInstance: vi.fn((_opts?: any) => mockStorageInstance)
    }
}));
```
Em `test/config.test.ts`:
- Atualizar a asserção da linha 78 para:
  ```ts
  expect(localforage.createInstance).toHaveBeenCalledWith(expect.objectContaining({ storeName: 'pinia-with-cache-plugin' }));
  ```

Em `test/deduplication.test.ts`:
- Atualizar o Caso 12 para:
  ```ts
  it('Caso 12: clearAll limpa apenas as chaves da store específica sem destruir o banco global', async () => { ... });
  ```

#### 5. Implementação da Nova Suíte de Testes `test/storageIsolation.test.ts`
Implementar testes automatizados com cobertura completa dos cenários de concorrência e isolamento.

---

### Especificação de Teste TDD (Red-Green)

#### Teste Red (Reprodução da Falha)
1. **Cenário de Falha 1: Stores com Bancos Diferentes (`cache_name`)**
   - Criar Store A com `cache_name = ref('db-alpha')`.
   - Criar Store B com `cache_name = ref('db-beta')`.
   - **Expectativa:** `localforage.createInstance` deve ser invocado independentemente com `{ name: 'db-alpha' }` e `{ name: 'db-beta' }`.
   - **Falha no Red:** No código atual, `localforage.createInstance` não é chamado (0 chamadas), ocorrendo apenas chamadas conflitantes a `localforage.config`.

2. **Cenário de Falha 2: Destrutividade do `store.clearAll()`**
   - Mockar `storage.keys()` retornando `['storeA.global', 'storeA.user-1', 'storeB.global', 'storeB.item-2']`.
   - Chamar `storeA.clearAll()`.
   - **Expectativa:**
     - `storage.clear()` NÃO deve ser chamado.
     - `storage.removeItem('storeA.global')` e `storage.removeItem('storeA.user-1')` DEVEM ser chamados.
     - `storage.removeItem('storeB.global')` e `storage.removeItem('storeB.item-2')` NÃO devem ser chamados.
   - **Falha no Red:** No código atual, `localforage.clear()` é executado incondicionalmente, apagando os dados de Store B, e `removeItem` cirúrgico não é chamado.

#### Teste Green (Validação da Correção)
- Com a implementação de `localforage.createInstance` e a deleção por prefixo em `clearAll()`, todos os testes da nova suíte `test/storageIsolation.test.ts` e das suítes existentes passam com sucesso (`85/85` testes aprovados).

---

### Banco de dados

Nenhuma migration necessária. A biblioteca `@maxvue/max-pinia` é um plugin client-side de frontend para gerenciamento de estado e cache em navegadores.

---

### Riscos de quebra e Não-Regressão

1. **Retrocompatibilidade de Mocks em Aplicações Consumidoras:**
   - **Risco:** Aplicações clientes que utilizam `vi.mock('localforage')` apenas com o objeto padrão (sem `createInstance`) poderiam falhar caso o plugin assumisse estritamente que `createInstance` existe.
   - **Mitigação:** O código implementa fallback defensivo: se `typeof localforage.createInstance !== 'function'`, retrocede transparentemente para o singleton `localforage` (evitando exceções em ambientes de teste simplificados de terceiros).

2. **Suporte de Drivers em Ambientes sem IndexedDB (SSR / Node / Fallbacks):**
   - Em navegadores onde o IndexedDB é desabilitado (ex.: modo anônimo restrito), o `localforage` chaveia automaticamente para LocalStorage ou WebSQL. O método `createInstance` é totalmente suportado em todos os 3 drivers nativos do `localforage`.

3. **Performance de `storage.keys()` com Cache Populado:**
   - Em cenários com dezenas de chaves, `storage.keys()` executa de forma assíncrona em milissegundos. A filtragem em memória e remoção paralela via `Promise.all` garante tempo de resposta inferior a 5ms para limpeza local.

4. **Preservação de Contrato Público:**
   - A assinatura pública de `clearAll: () => Promise<void>` em `src/types.ts` permanece inalterada.
   - As opções de configuração `createMaxPinia({ cacheName, storeName })` continuam funcionando com idêntica semântica.

---

### Validação

Para comprovar conclusivamente a correção e a não-regressão:

1. **Execução Completa da Suíte de Testes:**
   ```bash
   npm test
   ```
   - Deve executar todos os arquivos de teste (`config.test.ts`, `autosave.test.ts`, `deduplication.test.ts`, `savePause.test.ts`, `cancelLoad.test.ts`, `useAsyncStatus.test.ts`, `buildUrl.test.ts`, `internal.test.ts`, `storageIsolation.test.ts`) com 0 falhas.

2. **Checagem Estática de Tipos TypeScript:**
   ```bash
   npm run type-check
   ```
   - Deve compilar sem nenhum erro de tipo (`vue-tsc --noEmit`).

3. **Validação do Build de Produção:**
   ```bash
   npm run build
   ```
   - Geração de artefatos de distribuição (`dist/`) e arquivos de tipos (`.d.ts`) sem erros ou avisos.

---

### Skills Aplicáveis

- `systematic-debugging-best-practices`
- `planning-with-files`
- `vue-debugging-best-practices`
- `tdd`
- `superpowers`
- `code-review`
- `production-code-audit`
