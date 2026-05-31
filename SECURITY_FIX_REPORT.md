# SafeDisk Security Fix Report

Data: 2026-05-31

## Arquitetura Verificada

- Frontend: React + Vite, publicado como site estatico na Vercel a partir de `frontend/`.
- Backend: Express + TypeScript separado, publicado no Render a partir de `backend/`.
- Nao foram encontrados Next.js, API Routes da Vercel, Fastify, Nest, Swagger, OpenAPI publico, GraphQL ou painel admin real no codigo.
- O frontend nao usa `/api/*` same-origin; ele chama o backend local do usuario em `http://localhost:3335` e fallbacks locais.

## Correcoes Aplicadas

| Vulnerabilidade | Severidade | Arquivos alterados | Correcao aplicada | Como testar |
|---|---:|---|---|---|
| URL_002 - HTTP sem HTTPS | Alta | `frontend/vercel.json`, `backend/src/index.ts` | HSTS no frontend; backend redireciona GET HTTP para HTTPS em producao usando `x-forwarded-proto`. Localhost nao e afetado. | `curl -I http://safedisk.vercel.app/` deve redirecionar/usar HTTPS pela Vercel. |
| HEAD_002 - CSP ausente | Alta | `frontend/vercel.json`, `backend/src/index.ts` | CSP global no frontend e CSP restritiva para respostas da API. | `curl -I https://safedisk.vercel.app/` |
| HEAD_003 - X-Frame-Options ausente | Media | `frontend/vercel.json`, `backend/src/index.ts` | `X-Frame-Options: DENY`. | `curl -I https://safedisk.vercel.app/` |
| HEAD_004 - X-Content-Type-Options ausente | Media | `frontend/vercel.json`, `backend/src/index.ts` | `X-Content-Type-Options: nosniff`. | `curl -I https://safedisk.vercel.app/` |
| HEAD_005 - Referrer-Policy permissiva | Media | `frontend/vercel.json`, `backend/src/index.ts` | `Referrer-Policy: strict-origin-when-cross-origin`. | `curl -I https://safedisk.vercel.app/` |
| HEAD_008 - Permissions-Policy ausente | Media | `frontend/vercel.json`, `backend/src/index.ts` | Camera, microphone, geolocation, payment, usb, bluetooth e sensores bloqueados. | `curl -I https://safedisk.vercel.app/` |
| CORS_001 - Wildcard | Alta | `frontend/vercel.json`, `backend/src/index.ts`, `render.yaml`, `.env.example`, `backend/.env.example` | Removido wildcard. Backend usa allowlist `ALLOWED_ORIGINS`; Vercel fixa origem oficial e nao usa `*`. | `curl -i -H "Origin: https://evil.example" https://safedisk.vercel.app/api/health` |
| API_001 - Swagger/API docs publico | Media | `frontend/vercel.json`, `backend/src/index.ts` | Rotas `/swagger`, `/api-docs`, `/docs`, `/openapi*`, `/swagger.json` retornam 404. | `curl -i https://safedisk.vercel.app/swagger` |
| API_002 - GraphQL publico | Media | `frontend/vercel.json`, `backend/src/index.ts` | `/graphql` retorna 404; nao ha dependencia GraphQL no projeto. | `curl -i https://safedisk.vercel.app/graphql` |
| AUTHZ_001 - Painel admin acessivel | Alta | `frontend/vercel.json`, `backend/src/index.ts` | `/admin`, `/api/admin`, `/dashboard/admin`, `/painel*` retornam 401 com `WWW-Authenticate`. Nao ha painel admin real. | `curl -i https://safedisk.vercel.app/admin` |
| API_003 - Debug/diagnostico publico | Alta | `frontend/vercel.json`, `backend/src/index.ts` | `/debug`, `/diagnostics`, `/api/debug`, `/api/env`, `/api/config`, `/api/status` retornam 404. Healthcheck retorna apenas `{ "ok": true }`. | `curl -i https://safedisk.vercel.app/api/debug` |
| SECRET_004 - `.env` publico | Critica | `frontend/vercel.json`, `.gitignore`, `.env.example`, `backend/.env.example` | Paths sensiveis bloqueados antes do fallback SPA; `.gitignore` reforcado; examples sem valores reais. Nenhum `.env` encontrado em `public/`, `dist/`, `build/`, `static/` ou `assets/`. | `curl -i https://safedisk.vercel.app/.env` |
| Erros em producao | Media | `backend/src/index.ts` | Error handler global remove detalhes em `NODE_ENV=production`; stack trace nao e retornado ao cliente. | Forcar erro de validacao em API e confirmar resposta generica em producao. |
| Rate limit basico | Media | `backend/src/index.ts` | Rate limit em memoria para `/api/*` com `RATE_LIMIT_WINDOW_MS` e `RATE_LIMIT_MAX`. | Repetir chamadas a `/api/health` alem do limite configurado. |
| Validacao de caminhos SafeDisk | Alta | `backend/src/utils/safePaths.ts` | Bloqueio de traversal bruto, raizes de disco, pastas criticas do Windows e allowlist opcional `SAFEDISK_ALLOWED_ROOTS`. | Enviar path com `..` ou `C:\\Windows` em preview/start deve falhar. |

## Arquivos Sensiveis

Arquivos encontrados:

- `.env.example`
- `backend/.env.example`

Ambos contem apenas nomes de variaveis, sem valores reais.

Nao foram encontrados arquivos sensiveis em:

- `frontend/public/`
- `frontend/dist/`
- `build/`
- `static/`
- `assets/`

Padroes comuns de segredo verificados no codigo versionavel:

- Private keys
- AWS access key
- OpenAI-style `sk-*`
- GitHub PAT `ghp_*`
- Slack tokens
- Google API key `AIza*`

Resultado: nenhum segredo real encontrado no repositorio versionavel.

## Secrets Que Precisam Ser Rotacionados

- Nenhum segredo real foi encontrado no repositorio local ou em pastas publicas.
- Se o scanner externo capturou conteudo real de `.env` em deploy anterior, rotacionar imediatamente esses valores fora do repositorio. Registrar como: `SEGREDO ENCONTRADO — ROTACIONAR IMEDIATAMENTE`.

## Variaveis Necessarias

### Render

Configure no servico backend:

```txt
NODE_ENV=production
ALLOWED_ORIGINS=https://safedisk.vercel.app
SAFEDISK_DB_PATH=/tmp/safedisk.sqlite
SAFEDISK_LOG_DIR=/tmp/safedisk-logs
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=240
```

Opcional para restringir operacoes locais a pastas especificas:

```txt
SAFEDISK_ALLOWED_ROOTS=
SAFEDISK_ALLOW_SYSTEM_PATHS=
ADMIN_TOKEN=
```

### Vercel

Nenhuma variavel e obrigatoria para o frontend atual. Nao configurar secrets no frontend.

## Validacao Executada Localmente

```txt
npm install: OK
npm run lint: script nao definido
npm run typecheck: script nao definido
npm run build: OK
npx vercel build --prod --yes: OK
```

Observacao: `npm install` em Windows emitiu aviso de cleanup por arquivo `esbuild.exe` em uso, mas terminou com sucesso e sem vulnerabilidades.

Backend local validado em `http://localhost:3335`:

- `/api/health` retorna somente `{ "ok": true }`.
- Headers de seguranca presentes.
- CORS de origem maliciosa retorna 403 no preflight e nao retorna `Access-Control-Allow-Origin`.
- CORS de `https://safedisk.vercel.app` retorna origem especifica, metodos/headers permitidos e sem wildcard.
- `/.env`, `/.env.local`, `/secrets.json`, `/swagger`, `/graphql`, `/debug`, `/api/env`, `/api/config` retornam 404.
- `/admin` e `/api/admin` retornam 401.

## Checklist Curl Para Producao

Headers:

```bash
curl -I https://safedisk.vercel.app/
```

Deve conter:

```txt
content-security-policy
x-frame-options
x-content-type-options
referrer-policy
permissions-policy
strict-transport-security
```

Arquivos sensiveis:

```bash
curl -i https://safedisk.vercel.app/.env
curl -i https://safedisk.vercel.app/.env.local
curl -i https://safedisk.vercel.app/secrets.json
```

Resultado esperado: `403` ou `404`, nunca conteudo sensivel.

CORS:

```bash
curl -i -H "Origin: https://evil.example" https://safedisk.vercel.app/api/health
```

Resultado esperado: nao retornar `Access-Control-Allow-Origin: *`.

Swagger/API docs:

```bash
curl -i https://safedisk.vercel.app/swagger
curl -i https://safedisk.vercel.app/api-docs
curl -i https://safedisk.vercel.app/openapi.json
curl -i https://safedisk.vercel.app/swagger.json
```

Resultado esperado em producao: `404`, `403` ou autenticacao exigida.

GraphQL:

```bash
curl -i https://safedisk.vercel.app/graphql
```

Resultado esperado em producao: `404`, `403`, `401` ou endpoint protegido.

Admin:

```bash
curl -i https://safedisk.vercel.app/admin
curl -i https://safedisk.vercel.app/api/admin
```

Resultado esperado: `401`, `403` ou redirect para login seguro.

Debug:

```bash
curl -i https://safedisk.vercel.app/debug
curl -i https://safedisk.vercel.app/api/debug
curl -i https://safedisk.vercel.app/api/env
curl -i https://safedisk.vercel.app/api/config
```

Resultado esperado: `404`, `403` ou resposta minima sem dados sensiveis.

## Validacao Executada Em Producao

Deploy Vercel validado em:

```txt
https://safedisk.vercel.app/
```

Resultado observado em `curl -I` equivalente:

- `content-security-policy`: presente
- `x-frame-options`: `DENY`
- `x-content-type-options`: `nosniff`
- `referrer-policy`: `strict-origin-when-cross-origin`
- `permissions-policy`: presente
- `strict-transport-security`: `max-age=63072000; includeSubDomains; preload`
- `access-control-allow-origin`: `https://safedisk.vercel.app`, sem wildcard

Rotas testadas em producao:

```txt
/.env => 404
/.env.local => 404
/secrets.json => 404
/config.json => 404
/.git/config => 404
/swagger => 404
/api-docs => 404
/openapi.json => 404
/swagger.json => 404
/graphql => 404
/admin => 401
/api/admin => 401
/debug => 404
/api/debug => 404
/api/env => 404
/api/config => 404
/api/health => 404 no frontend Vercel
```

Teste CORS em producao:

```txt
Origin: https://evil.example
GET https://safedisk.vercel.app/api/health
Resultado: 404
Access-Control-Allow-Origin: https://safedisk.vercel.app
```

Conclusao: a origem maliciosa nao recebe wildcard nem eco da propria origem.

## Pendencias Manuais

- Confirmar no Render que `NODE_ENV=production` e `ALLOWED_ORIGINS=https://safedisk.vercel.app` estao configurados.
- Se qualquer secret real tiver sido exposto por deploy anterior fora deste repositorio, rotacionar imediatamente.
- Se o SafeDisk for empacotado como agente local, definir `SAFEDISK_ALLOWED_ROOTS` para limitar as pastas onde operacoes reais podem ocorrer.
- Reexecutar o scanner depois que Vercel e Render concluirem os redeploys.
