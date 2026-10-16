# Plano de execução — confiabilidade e uso do MaxPinia

Data: 2026-10-16 | Projeto: @maxvue/max-pinia 0.2.0 | Worktree: wt-0dd4897f

Raiz confirmada por pwd/git rev-parse: /home/johnattas/GitHub/MaxPinia/.max-code-worktrees/wt-0dd4897f.
Estado inicial da primeira análise: git status --short sem alterações. Na segunda revisão, apenas docs/plans e docs/notifications estavam não rastreados; documentos anteriores preservados e ampliados. Este plano propõe execução futura, não autoriza implementação nesta sessão.
Especificação normativa: [spec.md](./spec.md).

## Objetivo e público

Preservar os propósitos de cache offline, sincronização automática GET/POST, deduplicação e status reativo, com configuração injetada. Beneficiar aplicações que alternam registros, aguardam gravações, enfrentam indisponibilidade do armazenamento ou descartam stores.

## Evidências e prioridades

| Item | Evidência existente | Problema solucionado | Benefício e prioridade |
|---|---|---|---|
| A — propriedade do POST | src/plugin.ts:558–630; test/deduplication.test.ts:44–179 cobre concorrência, não novo POST após término | Controller não liberado bloqueia first/ignore; respostas/finally antigos afetam operação atual | Gravações repetidas e concorrentes confiáveis; alta |
| B — conclusão assíncrona | src/plugin.ts:412,442–445,514–545,602–629; src/types.ts:77–81 | await retorna antes de HTTP/storage; afterReload executa cedo | Sequenciamento seguro no consumidor; média |
| C — recuperação do cache | src/plugin.ts:447–503; test/deduplication.test.ts:496–516 | Erro local impede GET e flags antigas persistem | Aplicação continua funcionando com backend disponível; alta |
| D — descarte | src/plugin.ts:330–350,686–698; test/statusTimers.test.ts:111–139 só cobre timer de status | Retry/continuações sobrevivem ao descarte | Evita trabalho e mutação tardios; média |
| E — eventos | src/plugin.ts:204–207,714–729; src/helpers/internal.ts:12–29; test/useAsyncStatus.test.ts | Observação superficial não acompanha flags internas | Feedback real de atividade; média |
| F — defaults independentes | src/plugin.ts:109,155,664–684 | Edição de data altera por referência o modelo da próxima restauração | Formulário volta a valores iniciais sem reaproveitar edição anterior; média |
| G — identidade do autosave | src/plugin.ts:560–561,650–684 | Edição de A pode disparar POST de B após trocar id durante debounce | Evita gravação inesperada do registro recém-aberto; alta |
| H — options.id reativo | src/plugin.ts:115–116,659–684 | Chave muda sem reiniciar carga; data antigo permanece | Troca de registro consistente nas duas formas de configuração; alta |
| I — status de escrita local | src/plugin.ts:527–544; test/statusTimers.test.ts:218–261 | Finalização antiga encerra feedback da escrita mais recente | Indicador corresponde à última escrita da identidade atual; média |

Prioridades são avaliação estática de impacto, sem afirmar incidentes em produção. Leitura adicional: README.md, package.json, vite.config.ts, vitest.config.ts, .gitignore e test/config.test.ts. Não houve busca exaustiva de vulnerabilidades, benchmark, execução de suíte ou confirmação da árvore instalada. Não tomar contagem histórica de testes em CLAUDE.md como resultado atual.

## Decisões de compatibilidade

- Preservar aliases e sua precedência, opt-in isCached/is_cached, chave $id + id/global, isolamento de instâncias localforage e formato persistido. A correção de colisões na seleção de clearAll fica no escopo separado notificado ao final; não alegar isolamento universal para IDs com prefixo separado por ponto.
- Preservar debounce de 300ms, timers transitórios de 500ms, filtros de dados vazios e estratégias last/first/ignore/cancel/this.
- Não trocar bibliotecas nem mover todos os helpers para outro pacote. Não há frontend visual; as exigências de componentes UI não se aplicam.
- Aguardar operação própria; chamada ignorada não passa a aguardar operação alheia. Erro tratado continua consultável em status. Detalhes dos hooks/finalização estão na spec.
- only_cache continua significando preferir cache válido sem revalidar, não proibição absoluta de rede. Não introduzir mudança silenciosa nesse contrato.
- Não prometer entrega offline de edições: não existe fila persistente de reenvio. Não prometer que aborto HTTP reverte gravação no backend.
- Evitar refatoração estética, aumento de abstrações e otimização sem medição. Extrair helper privado somente se eliminar duplicação real das novas regras.

## T0 — preflight e retomada

Antes de alterar código, ler instruções aplicáveis e plano/spec; conferir diff e trabalho já existente. Não criar outra worktree nem trocar branch. Confirmar scripts/pre/post hooks, lockfile e versões efetivas por leitura, symlinks e resolução de Vue/Pinia/Axios usada pelo harness. Verificar que mocks isolam storage e rede de todos os testes executados; o caso de lazy Axios em test/deduplication.test.ts:584–598 merece conferência para não depender de rede real. Bloquear validação dependente se integridade das bibliotecas falhar; não contornar com ignoreConfig, remoção de hooks ou execução direta alternativa. Não copiar .env nem executar migrações/reset.

## T1 — POST (A)

Alterar src/plugin.ts e test/deduplication.test.ts. Capturar identidade/rota/controller, impedir efeitos obsoletos, liberar somente controller proprietário e tratar cancelamento. Usar o padrão de geração já presente no GET, sem compartilhar contadores entre canais. Falhas de obtenção do Axios/resolução de rota devem terminar status e permitir a próxima tentativa. Testar resposta tardia mesmo quando mock ignora AbortSignal; com save_return e reload_after_save verificar ausência de cache/recarga indevidos. Finalização antiga não deve desativar is_requesting de operação nova.

## T2 — conclusão (B), depende de T1

Alterar src/plugin.ts, src/types.ts e criar test/asyncCompletion.test.ts. Retornar as cadeias e aguardar cache derivado; preservar tratamento de erro por canal. Alinhar reload/saveInServer a Promise<void>. Balancear pausas mesmo se onServerData lançar erro. Garantir finalização no GET quando cancelamento/invalidação ocorrer durante obtenção do Axios. Não criar rede após cancelamento. Usar deferred promises: antes de resolver HTTP/storage, promessa pública ainda pendente; após finalizar, flags coerentes e hook na ordem prevista. Não aguardar publicamente uma operação antes de liberar sua deferred no teste, evitando deadlock.

## T3 — cache resiliente (C), depende de T2

Alterar src/plugin.ts e test/deduplication.test.ts. No erro de leitura atual, manter cache.get em erro e iniciar GET por fluxo existente uma única vez. Identidade obsoleta/desabilitada/descartada não inicia fallback. No início da próxima operação limpar erro anterior. Não ampliar para política nova de persistência nem apagar dados automaticamente. Testar indisponibilidade, recuperação, rota ausente e only_cache conforme spec.

## T4 — descarte (D), depende de T1–T3

Alterar src/plugin.ts e criar test/disposal.test.ts. Cleanup idempotente atende $dispose e onScopeDispose; aborta HTTP, invalida efeitos e cancela timers/retry. Guardar entradas assíncronas, nextTick e callback do debounce. Testar descarte antes do retry, durante lazy Axios, HTTP/storage pendentes e debounce já agendado. Desabilitar não equivale a descarte permanente: deve permitir reativação. Não tentar cancelar fisicamente setItem já iniciado.

## T5 — eventos e uso (E), depende de T4

Alterar src/plugin.ts, test/useAsyncStatus.test.ts e README.md. Observar as flags conhecidas e a referência error dos quatro canais, incluindo substituição de status no reset, sem percorrer o interior de erros Axios. Esta revisão substitui deep irrestrito para evitar travessia de configuração/corpos de erro; preservar payload, batching e ausência de mutação no próprio observador. Testar produtor e consumidor juntos, com EventTarget e escopo Vue; limpar eventos iniciais antes da mutação testada. Cobrir reset, ausência de document, descarte, mudança de referência de error e alteração de flags sem substituição do objeto status.

Atualizar README com registro pinia.use antes da criação das stores, exemplo completo com imports/app.use(pinia), Axios injetado, await e consulta de status, cacheName/storeName, resolveRoute/onActivity, aliases essenciais, pausa/retomada, only_cache, deduplicação e limites offline. Remover options.key do exemplo: a chave efetiva vem de $id e id/options.id, não dessa opção. Alinhar peers à faixa declarada, incluindo Pinia 4. Explicar que useAsyncStatus retorna último evento, não soma operações; não sugerir uso fora de escopo como padrão. Documentar os tempos e semânticas definidos na spec.

Todos os passos escrevem em src/plugin.ts: execução sequencial. Não delegar edição concorrente desse arquivo. Eventual revisão independente recebe referências aos documentos e diff do marco, não instrução de reler tudo a cada microalteração.

## Matriz de aceite

| Tarefa/requisito | Evidência futura exigida | Testes pertinentes | Revisão pelo risco / manual |
|---|---|---|---|
| T1: POST vigente | first/ignore aceitam nova chamada após sucesso/erro; cancelamento antigo não muda dados/status atuais | deduplication, deferred fora de ordem, troca de id/desabilitação, save_return | Revisar propriedade de controller e todos os callbacks; sem garantia de rollback HTTP |
| T2: conclusão | Promise fica pendente até HTTP e cache derivado terminarem; hook depois; saída ignorada imediata | asyncCompletion: sucesso, rejeição tratada, sem rota, hook lança, cancelamento durante lazy Axios | Revisar assinatura gerada e exemplo de await; nenhuma mudança acidental de erros públicos |
| T3: disponibilidade | Falha local permite exatamente um GET; sucesso posterior remove erro antigo | deduplication: cache rejeita/recupera, disabled, identidade obsoleta, only_cache | Conferir que dados/banco não são removidos por indisponibilidade |
| T4: descarte | Nenhum novo HTTP, cache derivado, hook ou mutação após descarte | disposal: timers falsos e promessas pendentes; cleanup duplicado | Separar recursos canceláveis de escrita já entregue; conferir reativação |
| T5: status e uso | Evento real após mutação aninhada e composable atualizado; README fiel | useAsyncStatus e regressões de statusTimers | Revisar exemplo completo, contrato detail e segurança SSR sem document |

## T7 — defaults independentes (F), depois de T5

Alterar src/plugin.ts e criar test/defaultData.test.ts. Clonar o valor resolvido por setDefaultData a cada atribuição, preservando seleção dos aliases. Cobrir objeto/array aninhado, default derivado de data inicial e default explícito conforme resolução vigente, troca de id, desabilitar/reativar e duas restaurações sucessivas. Usar cache vazio e ausência de GET para que uma resposta remota não esconda o compartilhamento. Assertar que editar data não altera o modelo e que a restauração não dispara autosave. Não corrigir precedência de aliases incidentalmente.

## T8 — identidade do autosave (G), depois de T7

Alterar src/plugin.ts e test/autosave.test.ts. Capturar token de geração/chave/rota na aceitação da edição, verificar no callback debounced e revalidar pausa/bloqueio. Comparar geração para detectar inclusive A → B → A. Manter debounce e countChanges existentes. A chamada manual mantém seu contrato; no-op automático não significa erro HTTP. Testar edição A → troca B antes de 300ms sem POST, nova edição em B produzindo somente POST de B, pausa/bloqueio entre agendamento e disparo, troca de rota, desabilitação/reativação e chamadas manuais preservadas. Dados iniciais não vazios nos cenários para evitar que filtros existentes mascarem o problema. Usar timers falsos e cache/HTTP controlados.

### Complemento da matriz de aceite

| Tarefa/requisito | Evidência futura exigida | Testes pertinentes | Revisão pelo risco / manual |
|---|---|---|---|
| T7: defaults | Alterar data não altera modelo; restauração retorna conteúdo inicial | defaultData com objetos/arrays, aliases resolvidos, id e enabled | Conferir que clonagem não muda precedência nem inicia POST |
| T8: autosave causal | Edição A não envia B; nova edição B envia B uma vez após 300ms | autosave com navegação, A→B→A, pausa, bloqueio e mudança de rota | Revisar token em agendamento e envio; chamada manual continua independente |

IDs novos foram adicionados sem renumerar tarefas preexistentes. Ordem final: T0 → T1 → T2 → T3 → T4 → T5 → T7 → T8 → T9 → T10 → T6. Todos compartilham plugin.ts e permanecem sequenciais. Executar suíte/build somente após o bloco completo.

## T9 — identidade efetiva (H), depois de T8

Alterar src/plugin.ts e test/readIdentity.test.ts. Incluir chave efetiva no ciclo de invalidação/carga, preservando store.id prioritário e idx conforme comportamento atual. Cobrir options.id A → B com store.id ausente, cache B carregado, resposta/cache A atrasado ignorado e A → B → A invalidando geração antiga. Cobrir store.id definido com options.id alterado: não recarregar por mudança que não altera a identidade efetiva. Verificar uma única carga por troca, enabled em ambos os níveis, ausência de POST automático de A para B e chave correta no saveInCache após B carregar. Não mudar formato de chave.

## T10 — status de escrita local (I), depois de T9

Alterar src/plugin.ts e criar test/cacheWriteStatus.test.ts. Capturar sequência/geração/chave, proteger then/catch/finally e manter Promise por operação. Casos: primeira termina enquanto segunda está pendente; primeira falha após segunda ter sucesso; primeira pertence a A e termina quando B está ativo; descarte durante escrita; erro seguido de nova tentativa limpa flags antigas. Usar setItem com promessas controladas, sem alegar que isso comprova ordenação física do IndexedDB. Não serializar gravações ou criar política de retry.

### Aceite adicional da última revisão

| Tarefa/requisito | Evidência futura exigida | Testes pertinentes | Revisão pelo risco / manual |
|---|---|---|---|
| T2: finalizar erro de preparação GET | ResolveRoute/createRequestMeta que lançam não deixam loading/controller presos; cancelamento antes do Axios não envia GET | asyncCompletion e cancelLoad, com nova tentativa posterior aceita | Verificar que finally antigo não altera status novo; retomar pausa após hook de dados falhar |
| T9: identidade via options.id | B carrega uma vez; A tardio ignorado; gravações usam B somente com conteúdo atual | readIdentity e regressão conjunta de autosave | Preservar precedência, idx e formato legado de chave |
| T10: status de escrita | Escrita antiga não encerra nem sobrescreve resultado atual; promessa própria ainda finaliza | cacheWriteStatus e statusTimers | Não confundir status mais recente com garantia de ordem física de gravação |

## T6 — validação e entrega (após T7–T10)

Implementar o bloco inteiro e suas regressões antes de executar npm test e npm run build dentro desta worktree. Build inclui tipos; não executar type-check novamente sem causa concreta. Corrigir falhas agrupadas e repetir apenas checks afetados ou inválidos pela nova revisão. Não enfraquecer testes existentes para acomodar regressões. Agrupar diagnóstico de bootstrap/resolução de módulos antes de repetir falhas equivalentes.

Revisão final: correção, simplicidade, compatibilidade dos aliases, ausência de dados sensíveis em novos logs, trabalho assíncrono limitado e preservação dos externos do bundle. Verificar diff e tipos gerados; não publicar. Aceite mínimo é suíte/tipos/build aprovados e matriz coberta. Testes controlados não comprovam funcionamento de IndexedDB real. Se o executor incluir essa validação real, usar origem e banco descartáveis identificados, sem dados pessoais, registrar resultado separado e manter manualPending até executá-la; não afirmar validação em navegador sem evidência.

Riscos: alteração de tempo das promessas/hooks pode revelar dependência indevida de retorno antecipado; documentar em README. Geração de operação deve impedir sucesso tardio sem bloquear nova operação válida. A observação dos eventos deve percorrer somente campos do contrato de status, não o interior do Error ou a store inteira. Reversão de código não reverte POST já processado nem cache gravado. Não há migração de dados, nova permissão, credencial ou fornecedor necessário.

## Registro de execução e handoff (somente durante Execute)

Registrar progresso nos marcos em docs/plans/wt-0dd4897f/execution-state.json, vinculado ao SHA256 real de plan.md e revisões factuais do conteúdo de cada tarefa. Nesta sessão Plan esse arquivo não deve ser escrito.

Usar schema version 2 estrito do executor, consultando sua definição antes de gerar o registro; não inventar campos além do schema. Proibidos blocker, diagnostic, branchSync, durableSync e followUp. Motivos ficam em nextAction (até 512 caracteres). Tarefas usam pending/running/completed/blocked/manualPending/validationFailed. verification tem {revision: SHA256, checks: [{command, revision: SHA256, result, exitCode?}]}; command tem até 4096 caracteres. Resultados de validação/check são passed/failed/pending, nunca blocked. Passed exige exitCode 0; failed exige inteiro diferente de zero; pending não aceita exitCode. Registrar comandos reais e todas as falhas, inclusive suíte completa. Não inferir exitCode de tool:end.ok. Hashes são reais, não rótulos. Checks vazios, resultado ausente ou falha vigente impedem validação integral. Version 1 é compatível, mas não comprova aprovação. Registro autodeclarado não prova execução nativa nem detecta omissões. Se schema não estiver acessível, registrar o impedimento no handoff, sem inventar o formato.

Retomadas: conferir arquivos já alterados, revisões e checks; executar lacunas e consultar somente trechos pertinentes. Não reabrir decisões sem evidência nova. Bloqueio exige próxima ação concreta; falha repetida exige diagnóstico antes de repetição. Tarefas assíncronas têm espera limitada e recuo, sem polling redundante. Cancelamento preserva trabalho parcial e pendências. Commit, merge, push e remoção da worktree pertencem ao painel MaxCode.

## Revisão do plano

Os nove itens melhoram contratos existentes, cada um com benefício, evidência e aceite. Não há troca de propósito, dependência nova, UI ou alteração de backend. A análise não garante ausência de outros defeitos. Riscos adicionais de logs e colisão de prefixos na limpeza foram notificados separadamente, sem reproduzir conteúdo sensível. Implementação e verificações permanecem futuras.

## Segunda verificação — relatório de validade e benefícios

Leitura adicional: test/autosave.test.ts:1–260, test/savePause.test.ts completo, test/readIdentity.test.ts completo e releitura de src/plugin.ts:510–711. Reutilizadas evidências anteriores do restante do plugin, tipos, helpers, documentação Vue e testes de deduplicação/status. Nenhuma alteração de código rastreado foi observada. Não houve execução de testes ou investigação da instalação efetiva; portanto confirmação aqui significa caminho demonstrado por leitura, não reprodução em runtime.

| Melhoria | Problema concreto para quem usa | Benefício esperado |
|---|---|---|
| A: liberar e identificar cada salvamento | Em first/ignore, salvar uma vez pode impedir os próximos salvamentos; uma resposta antiga pode afetar a tela atual | Permite salvar novamente e mantém dados/indicadores ligados ao envio correto |
| B: concluir a promessa no momento certo | await pode terminar enquanto rede ou armazenamento ainda trabalham | Permite fechar formulário ou iniciar próxima ação depois da conclusão, consultando status para saber se houve sucesso |
| C: buscar servidor quando cache falha | Uma falha do armazenamento do navegador impede a leitura mesmo com internet disponível | Permite continuar carregando dados do servidor e exibir separadamente a falha local |
| D: encerrar trabalho da store descartada | Retry e respostas pendentes continuam atuando após descarte | Evita novas buscas e efeitos sobre uma store que deixou de ser usada |
| E: emitir evento em mudanças reais de status | A referência pode continuar reativa, mas listeners não recebem evento para cada lote de alterações internas | Indicadores baseados em eventos recebem início/fim/erro de operações de forma consistente |
| F: separar valores iniciais dos editados | Editar um campo pode modificar o próprio modelo usado para limpar/restaurar o formulário | Nova restauração não carrega alterações acidentais do registro anterior |
| G: associar salvamento automático ao registro editado | Trocar de registro nos 300ms pode fazer a edição anterior disparar envio do novo registro | Só envia automaticamente quando a edição ainda pertence ao registro atual e continua autorizada |

Ressalvas que corrigem a leitura anterior: useAsyncStatus não perde necessariamente toda reatividade (ele pode reter o objeto reativo de um evento anterior); descarte não implica vazamento de todos os watchers; aguardar cache derivado é uma escolha proposta, não contrato historicamente comprovado. A spec detalha essas distinções. Os testes existentes de deduplicação, pausa e identidade cobrem partes importantes, mas não comprovam os sete cenários específicos desta matriz. A cobertura efetiva só será confirmada na execução.

## Última revisão aprofundada — 2026-10-16

Código rastreado permaneceu sem diff; diretórios documentais são as únicas entradas de git status. Leituras adicionais: src/index.ts, src/plugin.ts:90–209 e 330–509, test/cancelLoad.test.ts, test/storageIsolation.test.ts, restante de test/autosave.test.ts e test/statusTimers.test.ts. Foram reutilizadas as demais leituras das revisões anteriores e a documentação oficial Vue já consultada. Não houve instalação, script do projeto, teste ou build. A análise percorreu inicialização → cache → GET → edição → debounce → POST → cache → troca de identidade/descarte e limpeza.

### Validade dos sete achados anteriores

A: confirmado pelo controller nunca liberado e ausência de propriedade nos callbacks POST. B: confirmado pelas cadeias não retornadas; acrescentados caminhos de exceção síncrona e cancelamento precoce no GET. C: confirmado pelo catch de cache sem fallback e flags não limpas. D: confirmado para timer explícito e continuações, sem afirmar vazamento de watchers de escopo. E: confirmado para emissão de eventos, com referência reativa preservada; refinada a solução para não percorrer erros inteiros. F: confirmado pelo compartilhamento de referência; teste atual substitui objeto e não cobre mutação aninhada. G: confirmado pelo contador sem identidade e callback que lê dados atuais.

### Novos achados incluídos

- **Melhoria H — fazer options.id participar da troca de registro.** Problema: a chave muda, mas a rotina de carga não acompanha. **Benefício:** a tela recebe os dados do novo registro e não reutiliza dados antigos sob uma nova chave. Implementação/aceite: T9.
- **Melhoria I — mostrar status da escrita atual no cache.** Problema: a conclusão ou erro de uma escrita anterior interfere na mais recente. **Benefício:** evita indicar que o salvamento terminou enquanto o envio mais recente ao armazenamento ainda está pendente. Implementação/aceite: T10.

### Achado separado que exige decisão de compatibilidade

clearAll filtra por prefixo textual. Para stores com IDs cart e cart.items no mesmo banco/object store, limpar cart também seleciona cart.items.global. Há inclusive colisão exata entre store cart/id items.global e store cart.items/id global. O teste atual diferencia storeA/storeAB, mas não IDs separados por ponto. Notificação: ../../notifications/wt-0dd4897f/notifications/cache-key-prefix-collision.md. Benefício de uma solução futura: limpeza e persistência realmente isoladas entre stores. Não corrigir com split('.') nem cadastro apenas de stores abertas: dados legados não têm dono inequívoco. Esquema/metadados de propriedade e migração exigem escopo próprio; o bloco atual não comprova isolamento para esses nomes.

Outras limitações mantidas: cache offline não significa fila de edições offline; filtros de dados vazios e only_cache seguem o contrato observado; não há recomendação de substituir dependências, agregar status entre stores ou refatorar por estética. Estes limites não são apresentados como defeitos novos. A notificação anterior de logs permanece válida como risco condicionado ao conteúdo das requisições, sem evidência de vazamento real.
