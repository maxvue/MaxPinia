# Colisão de chaves e remoção entre stores com IDs separados por ponto

Data: 2026-10-16. Evidência estática; nenhum dado foi removido, nenhum teste foi executado. Exemplos abaixo são identificadores sintéticos.

## Localização e evidência

- src/plugin.ts:115–116: chave é concatenação de store.$id, ponto e id/options.id/global, sem codificação dos componentes.
- src/plugin.ts:700–705: clearAll seleciona chaves iguais ao ID ou iniciadas por `${store.$id}.` e as remove.
- test/storageIsolation.test.ts:157–190 cobre storeA versus storeAB, mas não storeA versus storeA.child.

No mesmo banco e object store, a store cart possui prefixo cart.; portanto cart.items.global, pertencente à store cart.items com identidade global, também é selecionada. Além disso, cart com identidade items.global produz exatamente a mesma chave que cart.items com identidade global. A instância isolada por nome de banco/object store não resolve uma colisão quando esses nomes são compartilhados.

## Impacto

clearAll pode remover cache de outra store; a colisão exata também permite que duas identidades usem a mesma entrada. O risco exige essas combinações de nomes e armazenamento compartilhado. Não foi comprovada ocorrência em aplicação consumidora nem exposição de dados reais.

## Encaminhamento

Tratar em escopo próprio, pois o plano atual preserva esquema e chaves legadas. Definir representação inequívoca de componentes ou metadados confiáveis de propriedade e decidir estratégia de migração/compatibilidade antes de implementar. Não inferir dono por split('.') nem apenas pelas stores atualmente instanciadas: isso não identifica com segurança entradas antigas. Não apagar entradas ambíguas automaticamente.

Critérios futuros: stores com IDs em prefixo e componentes com pontos persistem separadamente; limpar uma preserva a outra; migração explicita tratamento conservador de entradas ambíguas, rollback e aceitação do consumidor. Nenhuma garantia de correção integral desse caso é atribuída às tarefas atuais T0–T10.
