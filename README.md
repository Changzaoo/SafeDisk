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
- Backend: http://localhost:3333

## Usar o frontend online com discos locais

O site publicado em `https://safedisk.vercel.app` precisa de um backend rodando no seu Windows para enxergar HDs/SSDs e mover pastas locais. O backend hospedado no Render nao consegue acessar sua maquina.

No computador Windows, rode:

```powershell
cd safe-disk-transfer
npm install
npm run dev:backend
```

Depois, no site:

1. Abra `Configuracoes`.
2. Em `Conexao da API`, clique em `Local`.
3. Confirme que o backend ativo ficou `http://localhost:3333`.
4. Volte para `Dashboard` ou `Saude`.

Se quiser SMART avancado no Windows, instale o smartmontools localmente:

```powershell
winget install smartmontools.smartmontools
```

Se alguma porta ja estiver ocupada, rode em duas janelas com portas alternativas:

```powershell
$env:PORT="3335"; npm --prefix backend run dev
```

```powershell
$env:VITE_API_URL="http://localhost:3335"; npm --prefix frontend run dev -- --host 0.0.0.0 --port 5174
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
4. `FRONTEND_ORIGIN` ja esta definido como `https://safedisk.vercel.app`.
5. O health check fica em `/api/health`.

Variaveis usadas:

- `NODE_VERSION=24.15.0`
- `FRONTEND_ORIGIN=https://safedisk.vercel.app`
- `SAFEDISK_DB_PATH=/tmp/safedisk.sqlite`
- `SAFEDISK_LOG_DIR=/tmp/safedisk-logs`

### Frontend no Vercel

O projeto tem `frontend/vercel.json`. Configure o projeto do Vercel apontando para a pasta `frontend`.

Configuracao recomendada:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Root directory: `frontend`
- Environment variable: `VITE_API_URL=https://safedisk.onrender.com`

URL desejada:

- Frontend: `https://safedisk.vercel.app`
- Backend: `https://safedisk.onrender.com`

## smartmontools

A aplicacao usa comandos nativos do Windows para status basico. Para SMART avancado, instale o smartmontools:

```powershell
winget install smartmontools.smartmontools
```

Depois reinicie o backend. Alguns discos exigem executar o terminal como administrador para leitura SMART.

## Como usar

1. Abra o dashboard para ver discos, capacidade, espaco livre e status.
2. Em `Saude`, veja volumes, temperatura, horas de uso e atributos SMART quando disponiveis.
3. Em `Transferencia`, informe caminhos absolutos de arquivos ou pastas e uma pasta de destino.
4. Escolha o tratamento de conflitos: renomear, substituir, ignorar ou comparar hashes.
5. Use `Previa` antes da transferencia real.
6. Mantenha `Modo simulacao` ligado para validar o plano sem mover arquivos.
7. Ao iniciar uma transferencia real, confirme a operacao. O arquivo original so e apagado depois que o hash SHA-256 da copia bate com o da origem.

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
- O backend executa apenas funcoes fixas para PowerShell, WMIC e smartctl.
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
- `GET /api/history`
- `GET /api/history/export?format=json`
- `GET /api/history/export?format=csv`
