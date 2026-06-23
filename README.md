# @maxvue/max-pinia

Plugin do **Pinia** que adiciona a qualquer store:

- **Cache offline** via `localforage` (carrega do cache → revalida no servidor).
- **Sincronização automática** com o backend: `GET` ao montar e `POST` com *debounce* a cada mudança em `data`.
- **Deduplicação** de requisições concorrentes (`last` / `first` / `ignore` / `cancel`).
- **Status reativo** completo (`server.get`, `server.save`, `cache.get`, `cache.save`).
- **100% desacoplado**: nada de `process.env`, nenhuma store/serviço do app importado. Tudo é injetado via config no boot.

## Instalação

```bash
npm install @maxvue/max-pinia
```

Peer deps: `vue ^3.5`, `pinia ^3`, `axios ^1`, `@vueuse/core ^14`.

## Uso

```ts
import { createPinia } from 'pinia';
import { createMaxPinia } from '@maxvue/max-pinia';

const pinia = createPinia();

pinia.use(createMaxPinia({
    cacheName: 'app',
    // adapters opcionais — específicos do seu app
    getSessionToken: () => useSystemStore().session_token,
    isAppStarted:    () => useSystemStore().started,
    loading: {
        start:  (o) => useLoadingStore().start(o),
        stop:   (k) => useLoadingStore().stop(k),
        update: (o) => useLoadingStore().update(o),
    },
}));
```

### Definindo uma store cacheada

O plugin só age quando a store declara `isCached`. O contrato é por convenção:

```ts
export const useUserStore = defineStore('user', () => {
    const data = ref(null);
    const isCached = ref(true);

    const options = computed(() => ({
        get:  { route: '/user/data' },  // GET automático + cache
        save: '/user/save',             // opcional: POST com auto-save (debounce 300ms)
        key:  'user',
    }));

    return { data, options, isCached };
});
```

A store passa a expor: `status`, `reload()`, `saveInServer()`, `saveInCache()`, `clearAll()`, `cancelLoad()`, `is_done_to_show`, entre outros.

## Configuração (`MaxPiniaConfig`)

| Campo | Default | Descrição |
|---|---|---|
| `cacheName` | `'pinia'` | Nome do banco localforage. |
| `axios` | `axios` global | Instância axios a usar. |
| `getSessionToken` | `() => null` | Token enviado em `X-CSRF-TOKEN` nos POSTs. |
| `isAppStarted` | `() => true` | Gate para exibir loading. |
| `loading` | `{}` | Adapter de UI `{ start, stop, update }` (todos opcionais). |
| `requestTimeout` | `15000` | Timeout das requisições (ms). |

## Migração a partir do `piniaWithCache` legado

O contrato das stores é **idêntico** — só muda o registro do plugin:

```diff
- import { piniaWithCache } from '@/Stores/_Plugins/piniaWithCache';
- pinia.use(piniaWithCache);
+ import { createMaxPinia } from '@maxvue/max-pinia';
+ pinia.use(createMaxPinia({
+     getSessionToken: () => useSystemStore().session_token,
+     isAppStarted:    () => useSystemStore().started,
+     loading: { /* ...useLoadingStore */ },
+ }));
```

## Licença

MIT © Johnattas Santana
