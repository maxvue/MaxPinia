# Especificação — confiabilidade dos ciclos assíncronos

Data: 2026-10-16. Projeto: @maxvue/max-pinia 0.2.0. Worktree: wt-0dd4897f.

## 1. Contexto & Objetivo

A biblioteca acrescenta cache local, leitura cache-first com revalidação, GET/POST automáticos, deduplicação e status reativo a stores Pinia opt-in, desacoplada da aplicação por configuração injetada. O objetivo é tornar esses mesmos contratos confiáveis em concorrência, falhas e descarte, sem ampliar o produto para fila offline ou gerenciador de estado alternativo.

A análise foi estática. Não foram executados testes, instalações ou builds. Os defeitos abaixo têm caminhos identificáveis no código; sua reprodução automatizada integra a execução futura.

## 2. Escopo

Incluído: nove correções em src/plugin.ts, alinhamento das assinaturas assíncronas em src/types.ts, regressões e documentação de uso em README.md. Revisão final estática em 2026-10-16: A–G mantidos com ressalvas abaixo; H–I adicionados. Colisão de chaves na limpeza foi notificada separadamente, pois sua solução depende de contrato de propriedade/migração não incluído neste bloco.

Excluído: mudanças nos aliases e sua precedência, esquema/chaves do cache, migrações, regras para dados vazios, novas estratégias de deduplicação, refatoração geral, UI, dependências novas, publicação e integração Git. Não adicionar MaxComponentsUi ou MaxUse: não há implementação de interface e os helpers internos são deliberadamente desacoplados.

## 3. Arquitetura & Mudanças Técnicas

### A. POST com propriedade da operação

Evidência: src/plugin.ts:558–630 mantém signal_post_request após finalizar, não filtra respostas obsoletas e permite que finally antigo encerre status novo. Com first/ignore, uma segunda gravação pode ser ignorada mesmo após a primeira terminar. Com save_return, uma resposta antiga pode substituir dados atuais.

Proposta: cada POST captura controller, sequência, geração de identidade, chave e rota de escrita. Somente a operação vigente pode aplicar save_return, status, cache e recarga. Limpar o controller apenas quando ainda pertence à operação. Invalidar ao mudar identidade, desabilitar ou descartar. Revalidar após getAxios, antes de enviar. Cancelamento esperado não é erro de rede. Proteger preparação e envio com tratamento de erro e finalização, inclusive getAxios/resolveRoute. A finalização deve liberar os recursos da operação proprietária mesmo em falha de preparação. Balancear pauseSave/resumeSave com finally em aplicação de dados.

Benefício: gravações sequenciais voltam a funcionar em first/ignore; respostas antigas não contaminam a store nem encerram feedback de gravações recentes. AbortController não garante que o servidor desfaça um POST: não prometer ordenação transacional no backend.

### B. Promessas que representam conclusão

Evidência: loadInServer usa void axios.get (412); saveInServer não retorna axios.post (603); saveInCache não retorna setItem (529). reload aguarda apenas o disparo e chama afterReload cedo (442–445). Tipos de reload/saveInServer são void.

Proposta: retornar/aguardar as cadeias completas, incluindo finalização. reload e saveInServer passam a Promise<void>; saveInCache mantém Promise<void> com semântica efetiva. Sem rota, bloqueios e chamadas ignoradas resolvem imediatamente; não passam a aguardar outra requisição. Manter erros operacionais tratados em status, sem introduzir rejeição pública obrigatória. afterReload ocorre após encerramento da tentativa admitida, inclusive erro tratado, mas não após descarte ou invalidação de identidade. Preservar chamada em tentativa sem rota/ignorada enquanto a identidade permanece válida. GET/POST aguardam a gravação de cache que iniciam, mas POST não aguarda reload_after_save, evitando encadeamentos não solicitados. A rejeição do cache mantém seu canal de erro independente do sucesso HTTP.

Benefício: consumidores podem aguardar salvamento ou recarga antes de prosseguir, sem observar dados/flags intermediários por promessa resolvida prematuramente.

### C. Cache indisponível não bloqueia servidor

Evidência: catch de getItem (490–496) registra falha e encerra sem chamar loadInServer. Teste existente de falha de cache verifica só status.

Proposta: quando getItem falhar e a identidade ainda for atual, registrar o erro de cache e tentar GET uma vez, passando pelos gates existentes. Limpar error/is_error de cache.get ao iniciar nova leitura e de cache.save ao iniciar nova escrita. Manter o comportamento atual de only_cache: cache válido evita GET; ausência de cache já permite GET. Aplicar esse mesmo fallback à indisponibilidade, documentando que o nome não representa proibição absoluta de rede.

Benefício: falha de IndexedDB não impede usar backend disponível; erro anterior não permanece após recuperação. Não remover banco nem dados por indisponibilidade.

### D. Descarte terminal e idempotente

Evidência: $dispose/onScopeDispose (686–698) limpam apenas timers de status; cancel_timer e requisições continuam vivos. isReadIdentityCurrent não verifica descarte.

Proposta: cleanup único e idempotente em ambos os caminhos, marcando disposed, invalidando operações, abortando GET/POST e limpando retry/status. Entradas e continuações assíncronas verificam disposed; callbacks nextTick e debounce pendentes não podem criar trabalho novo. Liberar loading associado antes do descarte final. Não depender apenas do encerramento dos watchers para impedir callbacks já enfileirados.

Benefício: elimina retry e efeitos tardios em stores descartadas. Escritas de storage já entregues não são canceláveis; apenas seus efeitos locais e novos encadeamentos são suprimidos.

### E. Eventos refletem mutações do status

Evidência: watch(status) em 204–207 observa um Ref sem deep, enquanto flags são alteradas internamente. useDefaultReset retorna Ref (src/helpers/internal.ts:12–29). Testes do composable emitem eventos artificiais, não comprovam produção pela store.

Proposta: observar explicitamente as flags públicas e a referência error dos quatro canais, acompanhando também substituição do status no reset, mantendo batching padrão, nome status-updated e detail: Status. Não percorrer o interior de objetos de erro, criar agregação entre stores nem mudar formato do evento. Documentar useAsyncStatus como último status recebido, preferindo store.status quando o consumidor precisa de uma store específica.

Benefício: feedback global recebe mudanças reais, inclusive após a inicialização. Usar teste que limpe eventos iniciais e altere uma flag posteriormente.

### F. Restaurar valores iniciais sem reutilizar o objeto editável

Evidência: src/plugin.ts:109 cria uma cópia inicial, mas setDefaultData (155) atribui o objeto escolhido diretamente a store.data. A inicialização imediata (664–684) já faz essa atribuição. Uma edição aninhada em data pode, portanto, editar o próprio modelo que será usado na próxima restauração.

Proposta: resolver o valor pelas mesmas opções e precedência atuais e atribuir uma cópia profunda a data em cada restauração. Preservar tipos suportados pelo cloneDeep já usado no projeto. Não congelar objetos do consumidor nem mudar nomes ou precedência dos aliases.

Problema solucionado: ao editar um formulário e mudar de registro ou desabilitar/reativar a store, o suposto valor inicial pode conter a edição anterior. Benefício: cada restauração recebe seu próprio objeto, sem reaproveitar alterações do registro anterior. Prioridade média; impacto demonstrável por compartilhamento de referência, sem alegar incidente em produção.

### G. Vincular o autosave agendado à identidade que foi editada

Evidência: src/plugin.ts:650–657 agenda apenas pelo contador; o callback chama saveInServer, que lê rota/dados no momento da execução (560–561). A troca de id (664–684) não invalida esse agendamento. O cenário é editar A, trocar para B antes dos 300ms e o callback de A enviar os dados atuais de B.

Proposta: manter token privado do agendamento com geração, chave e rota de escrita capturadas quando a edição é aceita. Antes do envio automático, verificar token e identidade, enabled, disposed, pausa e flags de bloqueio atuais. Agendamento antigo vira no-op; nova edição válida substitui o token e mantém debounce de 300ms. Não alterar countChanges público nem aplicar flags exclusivas de autosave à chamada manual saveInServer. Se pausa/bloqueio invalidar o envio, não reenviar implicitamente ao retomar: exigir nova edição aceita.

Problema solucionado: uma edição de A dispara gravação inesperada de B; pausa ou bloqueio posteriores ao agendamento também não são rechecados hoje. Benefício: somente uma edição válida da identidade atual dispara POST automático. Prioridade alta. Não introduz fila para salvar A após navegação: esse comportamento exigiria outro contrato.

### H. Recarregar quando a identidade vier de options.id

Evidência: src/plugin.ts:115–116 aceita store.id ou options.id para a chave. O watch(key) em 659–662 apenas encerra loading. O ciclo que invalida, restaura e carrega (664–684) observa store.id, não options.id. Quando só options.id muda, a chave pode passar a B enquanto data permanece de A; saveInCache passa a usar B.

Proposta: incluir a chave efetiva na observação do ciclo de identidade, preservando a precedência store.id → options.id → global, os gates enabled e a atualização pública atual de idx. Não transformar mudança de filtros/rota em recarga automática neste item. Evitar ciclos duplicados para uma única troca de identidade e garantir invalidação síncrona antes de callbacks antigos. A chave e a geração corrigidas devem ser usadas pelas proteções A, D, G e I.

Problema solucionado: duas formas aceitas de identificar registro não provocam o mesmo ciclo de atualização. Benefício: quem configura o identificador em options.id também recebe os dados corretos ao trocar de registro, sem gravar por engano o conteúdo anterior sob a nova chave. Prioridade alta.

### I. Impedir que uma escrita antiga altere o status do cache atual

Evidência: src/plugin.ts:527–544 atualiza status.cache.save em then/catch/finally sem sequência ou identidade. Se uma escrita antiga termina enquanto a nova continua pendente, is_requesting vira false; se falha depois, pode marcar erro na operação mais recente. test/statusTimers.test.ts:218–261 cobre timers, mas resolve as duas escritas somente ao final, sem validar essa disputa.

Proposta: capturar sequência e geração/chave por escrita. O status representa a última escrita admitida da identidade atual, seguindo a convenção dos demais canais; somente ela publica resultado/finalização. Limpar success/error antigos ao iniciar a operação vigente e não publicar após descarte. Cada Promise pública aguarda sua própria escrita, mesmo que seu resultado deixe de ser o exibido. Não serializar setItem nem prometer ordem física de persistência: este item corrige feedback, não adiciona fila de storage.

Problema solucionado: a interface pode indicar que terminou de salvar, ou mostrar erro antigo, enquanto a última gravação ainda está em curso. Benefício: indicadores de cache correspondem à operação atual. Prioridade média.

### Resultado da revalidação A–G

- A confirmado: o controller POST nunca é limpo; first/ignore bloqueiam inclusive chamadas posteriores ao término. O risco de resposta obsoleta depende de concorrência e, para substituir data, de save_return.
- B confirmado: as cadeias HTTP/storage não são retornadas. Aguardar também o cache derivado é decisão proposta de API, não prova de intenção histórica; manter esse ponto explícito na revisão de compatibilidade.
- C confirmado: getItem rejeitado não tenta GET. A recuperação é uma melhoria coerente com cache-first, não algo garantido por teste atual. only_cache não deve ser reinterpretado como isolamento de rede.
- D confirmado para timer de retry e continuações HTTP/storage. Watchers síncronos já pertencem ao escopo Pinia; não afirmar que todos vazam. O comportamento de cancelamento do debounce pela versão efetiva do VueUse deverá ser conferido, mas o guard de descarte continua necessário para trabalho assíncrono já iniciado.
- E confirmado para emissão de eventos por mutações aninhadas. Ressalva: após receber um evento de reset, useAsyncStatus guarda a referência reativa e pode refletir mutações posteriores mesmo sem novo evento. O defeito é a emissão incompleta, não ausência universal de reatividade. O teste de evento em deduplication pode contar emissão inicial; a regressão precisa limpar esse histórico.
- F confirmado: o clone inicial não impede compartilhamento posterior feito por setDefaultData. test/autosave.test.ts:542–564 substitui data por outro objeto; não verifica edição aninhada do objeto inicial. Manter teste específico para esse caso.
- G confirmado: countChanges não leva identidade ao callback. Mesmo que o VueUse cancele timers ao descartar escopo, trocar id não descarta a store nem seu watcher. A nova cobertura deve usar defaults não vazios e também provar que uma edição legítima posterior é salva.

Complemento de B: o GET resolve rota e chama createRequestMeta antes do try (375–387); uma exceção síncrona deixa recursos/status sem finalização. O retorno em 410 também pula finishCurrentRequest quando a requisição é cancelada enquanto aguarda Axios. Envolver preparação, envio e callbacks na finalização protegida, sem permitir que uma operação antiga finalize a nova. Testar erro de resolveRoute/createRequestMeta e cancelamento durante Axios pendente. Essas são extensões do mesmo item B, não melhorias contadas novamente.

Limite de E: deep watch pode percorrer também o objeto error, que não é necessariamente pequeno. Preferir observar explicitamente as flags conhecidas e a referência error de cada um dos quatro canais, além da substituição de status no reset; emitir o mesmo detail sem percorrer internamente a configuração Axios. Esta abordagem substitui a sugestão de deep irrestrito e preserva batching. O aceite é emissão de mudanças do contrato público, não de mutações arbitrárias internas do objeto Error.

## 4. Plano de Execução Faseado

1. Preflight somente leitura e conferência de trabalho existente.
2. A: identidade e finalização POST; implementar regressões concorrentes.
3. B: conclusão das promessas, hooks, tipos e testes com promessas controladas.
4. C: recuperação do cache e limpeza dos erros; regressões de falha/recuperação.
5. D: ciclo de descarte; regressões com retry, HTTP e storage pendentes.
6. E: emissão real de status e documentação de uso; regressões de integração.
7. F: cópia independente dos defaults e regressões de restauração.
8. G: identidade do autosave agendado e regressões de navegação/pausa.
9. H: observar identidade efetiva, com regressões de options.id.
10. I: proteger o status de escritas do cache com sequência/identidade.
11. Validar o conjunto, corrigir falhas em lote, revisar contratos e entregar.

## 5. Critérios de Aceite & Validação

Matriz detalhada no plan.md. Comandos confirmados: npm test e npm run build (inclui vue-tsc). Não repetir type-check sobre o mesmo conteúdo. Testes usam Axios/storage controlados e timers falsos; nenhum backend ou cache de usuário. Não há evidência atual de execução aprovada. Integração real em navegador, quando realizada pelo executor, deve usar origem/banco temporários e dados sintéticos; não é comprovada por mocks.

Referência oficial consultada: https://vuejs.org/guide/essentials/watchers.html e https://vuejs.org/api/reactivity-core.html — watch é superficial por padrão. Documentação corrente da linha Vue 3, não uma certificação da versão instalada; package.json declara Vue ^3.6.0-rc.10 no desenvolvimento e ^3.5.0 como peer. Versões efetivas permanecem para preflight.
