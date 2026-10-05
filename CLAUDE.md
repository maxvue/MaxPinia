# MaxPinia — Diretrizes para Agentes de IA

Este documento define as diretrizes arquiteturais, padrões e convenções para agentes de IA (Claude, Gemini, Cursor, OpenCode, Codex) atuando no `@maxvue/max-pinia`.

## 1. Diretrizes de Idioma e Nomenclatura

- **Português do Brasil (pt-BR):**
  - Comunicação usuário ⇄ agente, planos de implementação, raciocínio e documentação.
  - Comentários no código e mensagens de commit.
  - Mensagens de log e erro (sempre prefixadas com `[max-pinia]`).
- **Inglês (en-US):**
  - Nomes de funções, variáveis, constantes, tipos, interfaces, propriedades e arquivos.

## 2. Visão Geral do Projeto

`@maxvue/max-pinia` é um **plugin do Pinia** publicado como pacote npm (ESM-only). Ele adiciona reatividade de nível de produção a qualquer store:
- **Cache offline** via `localforage` (padrão cache-first com revalidação automática).
- **Sincronização com backend:** GET na inicialização/ativação e POST com debounce (300ms) a cada mutação de `data`.
- **Deduplicação de requisições:** estratégias `last`, `first`, `ignore`, `cancel` e `this` via `AbortController`.
- **Status reativo unificado:** flags reativas em `store.status` (`server.get`, `server.save`, `cache.get`, `cache.save`) e evento global `CustomEvent('status-updated')` consumido por `useAsyncStatus()`.
- **Desacoplamento Total (100%):** nenhuma store ou dependência de aplicação específica é importada. Autenticação, loading adapters, rotas e axios são injetados no boot. Contrato intencionalmente idêntico ao legado `piniaWithCache`.

## 3. Comandos do Projeto

```bash
npm run build         # vue-tsc --noEmit && vite build (dist/ em ESM + .d.ts)
npm run type-check    # vue-tsc --noEmit (checagem estrita de tipos TypeScript)
npm test              # vitest run (executa a suíte completa de 111 testes)
npm run test:watch    # vitest em modo watch para desenvolvimento
npm run test:coverage # vitest com relatório de cobertura (v8)
npm run dev           # vite em modo dev
npm run release       # build + bump patch + push tags + npm publish
```

## 4. Qualidade e Testes Automatizados

O projeto possui uma suíte rigorosa de testes unitários e de integração desenvolvida em **Vitest** sob o diretório `test/` (11 suítes, 111 testes automatizados passando):
- `autosave.test.ts`: ciclo reativo de mudanças, debounce e pausa/retomada de gravação.
- `deduplication.test.ts`: estratégias de cancelamento, aborts em voo e variações de propriedades.
- `config.test.ts` e `internal.test.ts`: injeção de configurações, helpers e normalizações.
- `storageIsolation.test.ts`, `statusTimers.test.ts`, `buildUrl.test.ts`, `cancelLoad.test.ts`, `readIdentity.test.ts`, `savePause.test.ts`, `useAsyncStatus.test.ts`.

> **Regra Obrigatória:** Após implementar todo o bloco autorizado e seus testes, execute `npm test` e a checagem de tipos pertinente. Corrija falhas em lote e revalide depois. `npm run build` já inclui vue-tsc; não repita `type-check` sobre o mesmo conteúdo sem necessidade concreta. Nunca submeta código com testes falhando.

## 5. Arquitetura do Código

- [src/plugin.ts](src/plugin.ts) (~730 linhas): motor central do plugin. Contém o gate `isCached`, carregamento do cache, revalidação com backend, debounce de auto-save, deduplicação por requisição e emissão de eventos de status.
- [src/index.ts](src/index.ts): barrel de exports públicos (`createMaxPinia`, `useAsyncStatus` e contratos de tipos).
- [src/types.ts](src/types.ts): contratos TypeScript (`MaxPiniaConfig`, `Status`, `OperationStatus`, `LoadingAdapter`) e augmentação do Pinia (`declare module 'pinia'` com `PiniaCustomProperties`).
- [src/helpers/internal.ts](src/helpers/internal.ts): utilitários puros inlined (`getIn`, `anyIsFalseIn`, `useDefaultReset`, `watchValid`, `isNotEmpty`). Mantidos sem dependências externas para leveza do bundle.

## 6. Contrato Crítico por Convenção (Preservação de Aliases)

O plugin descobre a configuração das stores por convenção flexível utilizando `getIn`/`anyIsFalseIn`, tolerando múltiplos formatos (camelCase, snake_case, kebab-case e paths aninhados):
- **Rota GET:** `options.get.route`, `options.get`, `options.get_route`, `options.route`, etc.
- **Rota POST:** `options.save`, `options.post`, `options.route_post`, `save`, `post`, etc.
- **Default data:** `default_value`, `default_data`, `defaultData`, `dataDefault`, `data_default`.
- **Deduplicação:** `in_deduplication`, `in_get_deduplication`, `in_save_deduplication`, `in_post_deduplication`.

> **REGRA DE OURO:** NUNCA remova aliases existentes. A compatibilidade com aplicações legadas depende estritamente dessa resolução tolerante. Adições de novas chaves devem ser inseridas ao final das listas de fallback.

## 7. Configuração Injetada (`createMaxPinia`)

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `cacheName` | `string` | `'pinia'` | Nome do banco localforage. |
| `storeName` | `string` | `'max-pinia-cache'` | Nome do object store localforage (permite compatibilidade com caches antigos). |
| `axios` | `AxiosInstance` | Global `axios` | Instância HTTP utilizada (carregada via lazy import se não injetada). |
| `getSessionToken` | `() => string \| null` | `() => null` | Função que retorna o CSRF/Session token enviado em `X-CSRF-TOKEN` no POST. |
| `isAppStarted` | `() => boolean` | `() => true` | Gate condicional para ativação do adapter de loading. |
| `loading` | `LoadingAdapter` | `{}` | Callbacks opcionais de UI: `{ start, stop, update }`. |
| `requestTimeout` | `number` | `15000` | Timeout máximo das requisições HTTP (ms). |
| `resolveRoute` | `(r, p) => string` | Trata rota como URL | Resolve nomes de rota (ex: Ziggy) e query strings customizadas. |
| `onActivity` | `() => void` | `undefined` | Hook disparado em qualquer ciclo de leitura/escrita da store. |

## 8. Build e Publicação

- Build configurado no [vite.config.ts](vite.config.ts) em **Library Mode**, gerando exclusivamente formato ESM (`dist/index.es.js`) com sourcemaps e `.d.ts` gerados pelo `vite-plugin-dts`.
- `vue`, `pinia`, `axios` e `@vueuse/core` são estritamente **externos** (peerDependencies) — nunca devem ser embutidos no bundle.
- Não introduzir dependências vinculadas a ambientes específicos (sem `process.env` ou APIs proprietárias).

## 9. Fluxo de Trabalho de Agentes e Git Worktrees

1. **Apresentação Prévia de Plano:** Apresente plano para o escopo quando necessário e obtenha autorização; reutilize plano e autorização expressa já concedidos, sem repetir confirmação por etapa.
2. **Ambiente Isolado (Worktree):**
   - **Orquestração via MaxCode:** Se executado sob o MaxCode, a extensão já aloca um worktree isolado sob `.max-code-worktrees/wt-<id>`. O agente NÃO deve criar novos worktrees manuais, nem executar comandos de branch/commit/push por conta própria (ações exclusivas do usuário no painel).
   - **Execução CLI Autônoma:** Se executado via terminal direto, crie e opere em um worktree dedicado sob `.worktrees/wt-<slug>`, mantendo a branch principal protegida e aguardando confirmação para merge/limpeza.
3. **Resolução de Skills por Agente:**
   - Agente **Claude:** consultar `.claude/skills/<skill>/SKILL.md`.
   - Agente **Gemini:** consultar `.agents/skills/<skill>/SKILL.md`.


## Execução e validação em lote

- Implemente todo o bloco autorizado e seus testes antes de executar validações. Depois, valide o conjunto, corrija falhas em lote e revalide após concluir as correções. Não execute testes, tipos ou builds após cada microedição.
- Leia diretrizes na primeira admissão e consulte trechos necessários nas retomadas. Preserve decisões e autorização já concedidas; peça nova decisão somente para ampliação de escopo ou ambiguidade relevante.
- Comandos agregados já executam suas etapas: não repita testes, tipos, lint ou build sobre a mesma revisão sem mudança relevante, falha ou dúvida concreta.
- Preserve asserções, regressões, revisão final e gates de segurança/release. Falhas persistentes exigem diagnóstico; não amplie o escopo para corrigir baseline sem estabelecer causalidade e autorização.
- Informe progresso e limitações, sem segredos ou conclusão verde com verificações falhando/pendentes. Este fluxo não autoriza publicação, deploy ou integração Git.
