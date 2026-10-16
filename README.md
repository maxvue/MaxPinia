# @maxvue/max-pinia

Plugin do **Pinia** publicado como pacote ESM que adiciona a qualquer store:

- **Cache offline** via `localforage` (padrão cache-first com revalidação automática em segundo plano).
- **Sincronização com backend:** busca automática (`GET`) ao montar/ativar a store e envio (`POST`) com *debounce* (300ms) a cada mutação de `data`.
- **Deduplicação de requisições:** controle de concorrência com estratégias `last`, `first`, `ignore`, `cancel` e `this` via `AbortController`.
- **Status reativo unificado:** flags reativas granulares em `store.status` (`server.get`, `server.save`, `cache.get`, `cache.save`) e evento global unificado `status-updated` consumido pelo composable `useAsyncStatus()`.
- **Ciclo assíncrono confiável:** métodos `reload()`, `saveInServer()` e `saveInCache()` retornam `Promise<void>` que aguardam a conclusão do transporte HTTP e do cache derivado antes de resolver.
- **100% desacoplado:** sem variáveis de ambiente proprietárias (`process.env`) ou dependências rígidas de aplicação. Todas as instâncias e adaptadores são injetados no boot.

---

## Instalação

```bash
npm install @maxvue/max-pinia
```

### Peer Dependencies
- `vue`: `^3.5.0`
- `pinia`: `^3.0.0 || ^4.0.0`
- `axios`: `^1.0.0`
- `@vueuse/core`: `^14.0.0`

---

## Inicialização e Registro

> **Importante:** Sempre registre o plugin via `pinia.use(...)` **antes** de criar ou instanciar qualquer store na sua aplicação.

```ts
// main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import axios from 'axios';
import { createMaxPinia } from '@maxvue/max-pinia';
import App from './App.vue';

const app = createApp(App);
const pinia = createPinia();

pinia.use(createMaxPinia({
    cacheName: 'meu-app',
    storeName: 'max-pinia-cache',
    axios, // Instância do Axios compartilhada pela aplicação
    requestTimeout: 15000, // Timeout padrão de 15s
    getSessionToken: () => localStorage.getItem('csrf_token'),
    isAppStarted: () => true,
    loading: {
        start: (opts) => console.log('Início loading:', opts),
        stop: (key) => console.log('Fim loading:', key),
        update: (opts) => console.log('Progresso loading:', opts)
    },
    resolveRoute: (route, params) => {
        // Opcional: resolução de rotas nomeadas (ex: Ziggy)
        return route;
    },
    onActivity: () => {
        // Disparado a cada leitura ou escrita reativa
    }
}));

app.use(pinia);
app.mount('#app');
```

---

## Definindo uma Store Cacheada

O plugin é ativado na store quando ela expõe a propriedade reativa `isCached = ref(true)`. O contrato é resolvido por convenção flexível:

```ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useUserStore = defineStore('user', () => {
    const isCached = ref(true);
    const data = ref<Record<string, any>>({ name: '', role: 'guest' });
    const id = ref<string | number>('current'); // Identidade dinâmica da store

    const options = computed(() => ({
        get: {
            route: '/api/user/profile',
            data: { id: id.value }
        },
        save: '/api/user/save', // Dispara auto-save com debounce de 300ms a cada mutação de data
        in_save_deduplication: 'last' // Estratégia de concorrência: 'last' | 'first' | 'ignore' | 'cancel'
    }));

    return {
        isCached,
        id,
        data,
        options
    };
});
```

> **Atenção:** A chave efetiva de persistência no IndexedDB é composta exclusivamente por `$id` da store e pelo identificador dinâmico (`store.id` ou `options.id`). A opção `options.key` não é utilizada para compor a chave de armazenamento.

---

## Operações Assíncronas e Status Reativo

As operações da store retornam Promises completas que aguardam as operações de rede e gravação no cache local:

```ts
const userStore = useUserStore();

// Recarrega dados do servidor com fallback de cache
await userStore.reload();

// Força salvamento manual imediato no backend
await userStore.saveInServer();

// Salva o estado atual diretamente no cache offline
await userStore.saveInCache();

// Consulta o status reativo detalhado
if (userStore.status.server.save.is_success) {
    console.log('Salvo com sucesso!');
}

if (userStore.status.server.get.is_error) {
    console.error('Erro ao buscar dados:', userStore.status.server.get.error);
}
```

### Propriedades e Métodos Injetados na Store

- `store.status`: Objeto reativo com as flags de cada canal (`server.get`, `server.save`, `cache.get`, `cache.save`).
  - Cada canal expõe: `is_requested`, `is_success`, `is_error`, `error`, `count_success`, `count_errors`, etc.
- `store.reload()`: Executa nova requisição GET ao servidor e atualiza o cache local.
- `store.saveInServer()`: Envia imediatamente os dados atuais ao endpoint configurado em `save`/`post`.
- `store.saveInCache()`: Grava imediatamente os dados atuais no storage local (`localforage`).
- `store.cancelLoad()`: Aborta requisições de carga ativas.
- `store.pauseSave()` / `store.resumeSave()`: Suspende temporariamente o auto-save (útil para mutações em lote) e retoma o agendamento normal.
- `store.setDefaultData()`: Restaura `data` para o valor inicial configurado de forma isolada (sem compartilhar referências de objetos aninhados e sem disparar auto-save).
- `store.clearAll()`: Remove os registros em cache associados a esta store.
- `store.is_done_to_show`: Flag computada que indica quando a store concluiu sua primeira carga com sucesso (seja via cache ou servidor).

---

## Monitoramento Global com `useAsyncStatus`

O composable `useAsyncStatus()` consome o evento global `status-updated` disparado a cada alteração de ciclo de vida das stores gerenciadas:

```ts
import { useAsyncStatus } from '@maxvue/max-pinia';

export default {
    setup() {
        const lastStatus = useAsyncStatus();

        // lastStatus.value contém o payload do evento mais recente disparado por qualquer store
        // Nota: O composable reflete o último evento notificado, não agregando ou somando operações simultâneas de múltiplas stores.
        return { lastStatus };
    }
};
```

> `useAsyncStatus` é seguro para SSR: em ambientes onde `document` não existe, ele permanece inerte com valor reativo nulo sem lançar exceções.

---

## Configuração do Plugin (`MaxPiniaConfig`)

| Campo | Tipo | Padrão | Descrição |
|---|---|---|---|
| `cacheName` | `string` | `'pinia'` | Nome do banco IndexedDB criado pelo `localforage`. |
| `storeName` | `string` | `'max-pinia-cache'` | Nome da store/tabela no `localforage`. |
| `axios` | `AxiosInstance` | `axios` global | Instância HTTP do Axios utilizada nas requisições. |
| `getSessionToken` | `() => string \| null` | `() => null` | Função geradora de token CSRF/Session injetado no cabeçalho `X-CSRF-TOKEN` no POST. |
| `isAppStarted` | `() => boolean` | `() => true` | Condição necessária para ativar o adaptador de loading. |
| `loading` | `LoadingAdapter` | `{}` | Callbacks opcionais de UI: `{ start, stop, update }`. |
| `requestTimeout` | `number` | `15000` | Timeout máximo em milissegundos para chamadas HTTP. |
| `resolveRoute` | `(route, params) => string` | Trata como URL | Função customizada para resolução de URLs ou rotas nomeadas. |
| `onActivity` | `() => void` | `undefined` | Callback acionado a cada atividade de leitura/gravação. |

---

## Aliases por Convenção

Para garantir compatibilidade ampla com códigos legados, o `@maxvue/max-pinia` aceita múltiplos formatos e aliases de propriedades:

- **Rota de leitura (GET):** `options.get.route`, `options.get`, `options.get_route`, `options.route`.
- **Rota de escrita (POST):** `options.save`, `options.post`, `options.route_post`, `save`, `post`.
- **Valores iniciais/padrão:** `default_value`, `default_data`, `defaultData`, `dataDefault`, `data_default`.
- **Deduplicação:** `in_deduplication`, `in_get_deduplication`, `in_save_deduplication`, `in_post_deduplication`.
- **Exclusividade offline:** `store.only_cache = true` ou `options.only_cache = true` inibe chamadas remotas ao backend, operando exclusivamente sobre o IndexedDB local.

---

## Limitações do Modo Offline

O cache local do `@maxvue/max-pinia` é projetado como uma camada resiliente de leitura rápida e tolerância a quedas temporárias de conexão. Ele **não** substitui uma fila persistida transacional de edições em lote offline. Mutações offline sem conexão com o backend não serão gravadas no servidor até que haja uma chamada de sincronização com o serviço ativo.

---

## Licença

MIT © Johnattas Santana
