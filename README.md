# SafeDisk Transfer

Aplicacao local para Windows que verifica discos e move arquivos com um fluxo seguro: copia para `.partial`, calcula SHA-256 da origem e da copia, compara os hashes, renomeia para o nome final e so entao apaga o arquivo original.

Tambem inclui um modo de relocalizacao transparente para pastas de projetos ou programas: a pasta e copiada para outro disco, validada por hash, a pasta original vira backup e o caminho antigo recebe uma junction/symlink apontando para o novo local. Assim programas que continuam tentando ler `C:\Caminho\Antigo` passam a acessar os arquivos no novo disco.

## Stack

- Frontend: React + TypeScript + Vite
- Backend local: Node.js + Express + TypeScript
- Banco local: SQLite nativo do Node (`node:sqlite`)
- Logs: pasta `logs/`
- Sistema alvo: Windows

## Instalar

```powershell
cd safe-disk-transfer
npm run install:all
```

## Rodar em desenvolvimento

```powershell
npm run dev
```

URLs padrao:

- Frontend: http://localhost:5173
- Backend: http://localhost:3335

A porta `3333` e evitada porque costuma estar ocupada por outros projetos locais. Se `3335` ja estiver ocupada, o backend local tenta automaticamente `3336`, `3340` e `3341`. O frontend publicado tambem tenta detectar essas portas locais.

## Usar o frontend online com discos locais

O site publicado em `https://safedisk.vercel.app` precisa de um backend rodando no seu Windows para enxergar HDs/SSDs e mover pastas locais. O backend hospedado no Render nao consegue acessar sua maquina.

No computador Windows, rode:

```powershell
cd safe-disk-transfer
npm install
npm run dev:backend
```

Depois, no site:

1. Abra `Dashboard` ou `Saude`.
2. O frontend usa o backend local automaticamente.
3. Ele usa `3335` por padrao e tenta detectar `3336`, `3340` ou `3341` se necessario.

Se alguma porta ja estiver ocupada, rode em duas janelas com portas alternativas:

```powershell
$env:PORT="3336"; npm --prefix backend run dev
```

```powershell
npm --prefix frontend run dev -- --host 0.0.0.0 --port 5174
```

## Build

```powershell
npm run build
```

## Deploy em Vercel e Render

Este projeto foi pensado para rodar localmente no Windows. O deploy em nuvem serve para hospedar a interface e uma API online de demonstracao. O backend no Render nao consegue acessar discos, SMART nem arquivos do seu computador.

### Backend no Render

O arquivo `render.yaml` ja define o servico `safedisk`.

1. No Render, crie um Blueprint a partir do repositorio.
2. Use o `render.yaml` da raiz.
3. O servico esta nomeado como `safedisk`, para usar `https://safedisk.onrender.com`.
4. `ALLOWED_ORIGINS` ja esta definido como `https://safedisk.vercel.app`.
5. O health check fica em `/api/health`.

Variaveis usadas:

- `NODE_VERSION=24.15.0`
- `ALLOWED_ORIGINS=https://safedisk.vercel.app`
- `SAFEDISK_DB_PATH=/tmp/safedisk.sqlite`
- `SAFEDISK_LOG_DIR=/tmp/safedisk-logs`

### Frontend no Vercel

O projeto tem `frontend/vercel.json`. Configure o projeto do Vercel apontando para a pasta `frontend`.

Configuracao recomendada:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `frontend`

O frontend publicado tambem usa `http://localhost:3335` por padrao, porque a funcao principal do SafeDisk e acessar os discos da maquina do usuario.

URL desejada:

- Frontend: `https://safedisk.vercel.app`
- Backend: `https://safedisk.onrender.com`

## Como usar

1. Abra o dashboard para ver discos, capacidade, espaco livre e status.
2. Em `Saude`, veja volumes, status do Windows e indicadores avancados quando ja estiverem disponiveis no sistema.
3. Em `Transferencia`, informe caminhos absolutos de arquivos ou pastas e uma pasta de destino.
4. Escolha o tratamento de conflitos: renomear, substituir, ignorar ou comparar hashes.
5. Use `Previa` antes da transferencia real.
6. Mantenha `Modo simulacao` ligado para validar o plano sem mover arquivos.
7. Ao iniciar uma transferencia real, confirme a operacao. O arquivo original so e apagado depois que o hash SHA-256 da copia bate com o da origem.

## Recuperacao de Arquivos

A area `Recuperacao` fica no menu lateral e tambem aparece como card no dashboard. Ela adiciona um assistente para tentar encontrar arquivos apagados, perdidos, ocultos, esquecidos em pastas comuns ou extraidos de uma copia de disco.

Fluxo recomendado:

1. Abra `Recuperacao`.
2. Clique em `Comecar recuperacao`.
3. Escolha o que aconteceu.
4. Informe onde os arquivos estavam.
5. Informe uma pasta de destino em outro disco ou outra unidade.
6. Escolha `Busca rapida`, `Busca profunda`, `Verificar saude primeiro` ou `Criar copia segura`.
7. Revise e clique em `Iniciar com seguranca`.

Regras de seguranca aplicadas:

- O destino nao pode ser o mesmo disco/unidade da origem.
- O destino nao pode ficar dentro da pasta analisada.
- Arquivos encontrados nao sobrescrevem arquivos existentes; o nome e ajustado automaticamente.
- O modulo nao formata, nao corrige disco automaticamente, nao roda CHKDSK e nao apaga arquivos de origem.
- Nenhum arquivo e enviado para internet.
- O historico salva somente metadados da busca, nunca o conteudo dos arquivos.

### Busca rapida

A busca rapida funciona em pastas acessiveis pelo backend local. Ela procura arquivos por tipos escolhidos, arquivos recentes, arquivos temporarios, itens ocultos por nome e, quando possivel, a lixeira local da unidade. Tambem pode incluir Downloads, Documentos, Area de Trabalho, Imagens e Videos.

Ela ajuda a encontrar arquivos perdidos, movidos, ocultos ou esquecidos. Nao promete recuperar dados ja removidos fisicamente do dispositivo.

### Busca profunda

A busca profunda funciona sobre um arquivo de imagem ou arquivo binario grande escolhido pelo usuario, como `.img`, `.dd`, `.iso`, `.bin` ou `.raw`. Ela le em blocos para nao carregar tudo na memoria e tenta salvar arquivos encontrados em pastas por tipo:

- Imagens
- Documentos
- Videos
- Audios
- Arquivos compactados
- Outros

Tipos preparados: JPG/JPEG, PNG, GIF, PDF, ZIP, DOCX, XLSX, PPTX, MP4, MP3 e trechos TXT quando possivel. Alguns arquivos podem receber nomes novos como `recuperado_0001.jpg` porque o nome original pode nao estar mais disponivel.

### Criar copia segura

`Criar copia segura` copia arquivos acessiveis da origem para uma pasta nova no destino antes da recuperacao. Isso reduz a necessidade de mexer direto no original. Para imagem de disco real ou disco fisico inteiro, a estrutura fica preparada, mas depende de permissao/ferramenta externa adequada.

### Historico e relatorios

O modulo grava historico local em SQLite com data, problema escolhido, origem, destino, modo usado, quantidade encontrada, quantidade salva e status. Ao concluir, tambem gera relatorio `.txt` simples e `.json` avancado na pasta de destino quando possivel.

### Ferramentas externas

A tela `Ajuda` detecta integracoes preparadas:

- Windows File Recovery (`winfr.exe`), se instalado.
- PhotoRec/TestDisk, se os executaveis estiverem em uma pasta `tools/`.

Pastas procuradas:

- `safe-disk-transfer/tools`
- `safe-disk-transfer/backend/tools`
- pasta `tools` acima do diretorio atual do backend

Ferramentas proprietarias como Recuva, DMDE, R-Studio, Disk Drill, EaseUS e Stellar sao listadas apenas como opcoes externas. O SafeDisk nao automatiza ferramentas fechadas.

### Modo demonstracao

O `Modo demonstracao` simula progresso, arquivos encontrados, resultado e historico sem ler ou salvar arquivos reais. Use para testar a interface.

### Limitacoes reais

- No navegador puro nao ha acesso direto a discos fisicos; o backend local precisa estar rodando.
- Para analisar um disco inteiro de forma profunda, o aplicativo precisa de uma copia de disco ou uma integracao desktop/ferramenta externa.
- Em alguns SSDs, arquivos apagados podem ser limpos automaticamente pelo proprio dispositivo, reduzindo a chance.
- Se um HD faz barulho ou trava muito, desligue e procure ajuda especializada.

## Relocar projetos ou programas sem quebrar caminhos

Na tela `Transferencia`, selecione `Relocar pasta`.

1. Informe a pasta original, por exemplo `C:\Projetos\MeuProjeto`.
2. Informe a pasta de destino, por exemplo `D:\Projetos`.
3. Opcionalmente defina o nome final no destino.
4. Use `Junction` por padrao no Windows. `Symlink` pode exigir permissao de administrador ou modo desenvolvedor.
5. Rode a `Previa`.
6. Feche editores, servidores, launchers e programas que estejam usando a pasta.
7. Inicie a relocalizacao real.

Fluxo usado:

1. Copia a pasta para `D:\Projetos\MeuProjeto.safedisk-partial`.
2. Calcula SHA-256 dos arquivos originais e copiados.
3. Se tudo bater, promove a pasta temporaria para `D:\Projetos\MeuProjeto`.
4. Move a pasta antiga para `C:\Projetos\MeuProjeto.safedisk-backup-*`.
5. Cria uma junction em `C:\Projetos\MeuProjeto` apontando para `D:\Projetos\MeuProjeto`.
6. Mantem o backup por padrao.

Para liberar espaco de verdade, desmarque `Manter backup da pasta original` apenas quando tiver certeza de que o programa abriu corretamente pelo caminho antigo. Para programas instalados, a junction normalmente preserva leituras e escritas de arquivos, mas nao altera servicos, drivers, registros do Windows, variaveis de ambiente ou atalhos que usem caminhos internos diferentes.

## Seguranca

- O frontend nao envia comandos livres ao backend.
- O backend executa apenas funcoes fixas para PowerShell, WMIC e leitura de disco.
- Caminhos recebidos sao normalizados e precisam ser absolutos.
- Arquivos `.partial` sao removidos quando uma copia falha.
- Sobrescrita so ocorre com `conflictMode: "replace"`.
- O plano de transferencia e salvo em `logs/transfer-plan-*.json` antes do job real.
- O plano de relocalizacao e salvo em `logs/relocation-plan-*.json` antes do job real.
- Historico e salvo em SQLite em `backend/data/safedisk.sqlite`.

## Limitacoes do navegador

Navegadores nao fornecem acesso total a discos fisicos, SMART, locks de arquivos ou caminhos reais de arquivos arrastados. Por isso o projeto usa backend local. A interface aceita caminhos digitados; uma ponte nativa com Electron pode ser adicionada depois para janelas de selecao de arquivos/pastas.

## Status dos discos

- `Saudavel`: Windows/SMART nao indicou risco.
- `Atencao`: ha sinais como temperatura alta, setores realocados, erros SMART ou saude degradada.
- `Critico`: indicadores fortes de falha ou status ruim.
- `Desconhecido`: comandos do sistema nao retornaram dados suficientes.

## Endpoints principais

- `GET /api/disks`
- `GET /api/disks/health`
- `GET /api/disks/:id`
- `GET /api/disks/smartctl`
- `POST /api/transfer/preview`
- `POST /api/transfer/start`
- `GET /api/transfer/status/:jobId`
- `POST /api/transfer/pause/:jobId`
- `POST /api/transfer/resume/:jobId`
- `POST /api/transfer/cancel/:jobId`
- `POST /api/relocation/preview`
- `POST /api/relocation/start`
- `GET /api/relocation/status/:jobId`
- `POST /api/relocation/cancel/:jobId`
- `GET /api/recovery/locations`
- `POST /api/recovery/validate-paths`
- `GET /api/recovery/health-check?originPath=...`
- `GET /api/recovery/tools`
- `POST /api/recovery/start`
- `GET /api/recovery/status/:jobId`
- `POST /api/recovery/cancel/:jobId`
- `GET /api/recovery/history`
- `GET /api/recovery/report/:jobId?format=txt`
- `GET /api/recovery/report/:jobId?format=json`
- `POST /api/recovery/open-folder`
- `GET /api/history`
- `GET /api/history/export?format=json`
- `GET /api/history/export?format=csv`
