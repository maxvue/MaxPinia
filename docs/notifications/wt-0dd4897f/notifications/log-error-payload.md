# Objetos completos de erro nos logs

Data: 2026-10-16. Achado estático, fora do bloco funcional proposto.

Localização: src/plugin.ts:433 e 621, além de outros console.error no fluxo de requisições.

Evidência: o código entrega objetos de erro HTTP completos ao console; o GET também registra os parâmetros de consulta. O POST configura cabeçalho de sessão em 580–595. Objetos de erro Axios podem carregar configuração da requisição. Nenhum segredo real foi identificado ou reproduzido nesta notificação.

Impacto: conforme o conteúdo das requisições e a captura de logs da aplicação, parâmetros, corpo e cabeçalhos sensíveis podem ser expostos na console ou enviados à observabilidade. A ocorrência concreta não foi verificada.

Recomendação para escopo separado: reduzir logs a campos explicitamente permitidos, sem configuração HTTP, headers, corpo ou parâmetros; testar sanitização usando dados sintéticos. Preservar o objeto de erro no status quando necessário ao contrato público, distinguindo estado interno de exportação para logs. Não realizar varredura de credenciais ou rotação sem evidência e autorização.
