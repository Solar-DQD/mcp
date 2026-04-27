# MCP DQD

Servidor MCP (Model Context Protocol) que expone las bases de datos internas de DQD a clientes compatibles como Claude, con autenticación OAuth 2.0 contra Azure AD y control de acceso por módulo.

## Descripción

Servicio backend escrito en TypeScript sobre el SDK oficial de MCP (`@modelcontextprotocol/sdk`) que corre un servidor HTTP con transporte `StreamableHTTP`. Implementa el flujo completo de OAuth 2.0 (Dynamic Client Registration + PKCE) delegando la autenticación en Azure AD, emite un JWT propio para las sesiones de MCP y registra herramientas de consulta SQL de solo lectura sobre tres bases heterogéneas (SQL Server, PostgreSQL y MySQL). Los permisos por usuario se leen de una tabla `dbo.permisos` en SQL Server y habilitan o deshabilitan cada módulo de forma independiente.

## Stack

- Node.js 20+
- TypeScript (ES2022, módulos ESNext)
- `@modelcontextprotocol/sdk` (MCP server + StreamableHTTP transport)
- OAuth 2.0 con Azure AD (DCR + PKCE) y `openid-client`
- JWT vía `jsonwebtoken` para las sesiones internas
- `mssql` para SQL Server, `pg` para PostgreSQL, `mysql2` para MySQL
- `zod` para validación de parámetros de herramientas
- `dotenv` para configuración

## Requisitos

- Node.js 20+ instalado
- Aplicación registrada en Azure AD (tenant, client id y client secret) con `redirect_uri` apuntando a `${BASE_URL}/oauth/callback`
- SQL Server accesible con las bases de asistencia, legajo y persmisos
- PostgreSQL accesible para la base de jornadas/RRHH
- MySQL accesible para la base de Protrack
- Archivo `.env` configurado en la raíz
- Archivo `config.json` en la raíz con el mapeo de proyectos y las descripciones de schema

## Setup

```bash
npm install
```

Crear el archivo `.env` en la raíz con las credenciales reales (ver sección siguiente).

```bash
npm run build
npm start
```

> Este repositorio no incluye un `.env.example`, por lo que el archivo debe crearse manualmente.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PORT` | Puerto HTTP del servidor |
| `BASE_URL` | URL pública del servidor (se usa en los metadatos de OAuth y como `redirect_uri` hacia Azure) |
| `PATH_URL` | Path del endpoint MCP (el servidor expone `/{PATH_URL}`) |
| `JWT_SECRET` | Clave secreta para firmar los JWT emitidos al cliente MCP |
| `AZURE_TENANT_ID` | Tenant ID de Azure AD |
| `AZURE_CLIENT_ID` | Client ID de la app registrada en Azure AD |
| `AZURE_CLIENT_SECRET` | Client Secret de la app registrada en Azure AD |
| `MSSQL_HOST` | Host de SQL Server |
| `MSSQL_PORT` | Puerto de SQL Server |
| `MSSQL_USER` | Usuario de SQL Server |
| `MSSQL_PASSWORD` | Contraseña de SQL Server |
| `MSSQL_ASISTENCIA_DATABASE` | Base de asistencia (`control_de_accesos`) |
| `MSSQL_LEGAJO_DATABASE` | Base del legajo |
| `MSSQL_PERMISOS_DATABASE` | Base de permisos |
| `PSQL_DB_HOST` | Host de PostgreSQL |
| `PSQL_DB_PORT` | Puerto de PostgreSQL |
| `PSQL_DB_USERNAME` | Usuario de PostgreSQL |
| `PSQL_DB_PASSWORD` | Contraseña de PostgreSQL |
| `PSQL_DB_DATABASE` | Base de jornadas/RRHH |
| `MYSQL_HOST` | Host de MySQL |
| `MYSQL_PORT` | Puerto de MySQL |
| `MYSQL_USER` | Usuario de MySQL |
| `MYSQL_PASSWORD` | Contraseña de MySQL |
| `MYSQL_DATABASE` | Base de Protrack |

## Scripts

| Script | Descripción |
|---|---|
| `npm run build` | Compilar TypeScript a `dist/` |
| `npm start` | Ejecutar la aplicación compilada (`node dist/index.js`) |

## Endpoints HTTP

### Metadatos de OAuth

- `GET /.well-known/oauth-protected-resource` — metadatos del recurso protegido (resource, authorization servers, bearer methods)
- `GET /.well-known/oauth-authorization-server` — metadatos del authorization server (issuer, endpoints, tipos de grant, métodos PKCE)

### Flujo OAuth 2.0

- `POST /oauth/register` (alias `POST /register`) — Dynamic Client Registration, retorna `client_id` y `redirect_uris` aceptados
- `GET /oauth/authorize` (alias `GET /authorize`) — inicia el flujo y redirige al endpoint de autorización de Azure AD
- `GET /oauth/callback` — callback desde Azure AD, canjea el `code` por el `id_token`, extrae el email y emite un authorization code propio
- `POST /oauth/token` (alias `POST /token`) — intercambia el authorization code por un JWT Bearer (expira en 8h), valida PKCE

### MCP

- `POST|GET|DELETE /{PATH_URL}` — endpoint MCP con transporte StreamableHTTP, requiere `Authorization: Bearer <jwt>`. Ante token inválido responde `401` con header `WWW-Authenticate` apuntando a los metadatos del recurso.

## Herramientas MCP

Todas las herramientas de consulta SQL aplican las mismas guardas: la query debe empezar con `SELECT` y rechazan cualquier coincidencia con `INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|DENY`.

## Arquitectura y módulos

- [src/index.ts](src/index.ts) — servidor HTTP, ruteo de OAuth, montaje del `McpServer` y registro condicional de módulos según los permisos del usuario
- [src/auth.ts](src/auth.ts) — DCR, flujo OAuth con Azure AD, manejo de PKCE, emisión y verificación de JWT
- [src/permisos.ts](src/permisos.ts) — consulta a base de permisos para obtener los módulos habilitados por email
- [src/modules/asistencia.ts](src/modules/asistencia.ts) — herramientas de asistencia y jornadas (SQL Server + PostgreSQL)
- [src/modules/protrack.ts](src/modules/protrack.ts) — herramienta de Protrack (MySQL)
- [src/modules/legajo.ts](src/modules/legajo.ts) — herramienta de legajo digital (SQL Server)
- [config.json](config.json) — mapeo de dispositivos por proyecto y descripciones de schema inyectadas en la documentación de cada herramienta

## Estructura principal

```text
src/
  index.ts
  auth.ts
  permisos.ts
  modules/
    asistencia.ts
    protrack.ts
    legajo.ts
config.json
package.json
tsconfig.json
```

## Notas

- Los usuarios SQL de las tres bases deben ser **read-only**; el filtro de SELECT en las herramientas es una defensa adicional, no la única.
- Los módulos siempre se registran en el servidor MCP, pero las herramientas verifican `tienePermiso` antes de ejecutar; un usuario sin acceso ve la tool y recibe un mensaje explicativo al invocarla.
- El JWT emitido tiene una vida de 8 horas; los authorization codes internos duran 5 minutos y los `state` de Azure, 10 minutos.
- La app en Azure AD debe tener configurado `${BASE_URL}/oauth/callback` como redirect URI y habilitados los scopes `openid profile email`.
- El descubrimiento de la identidad se hace decodificando el `id_token` sin validar firma (es interno entre el servidor y Azure); el email se toma de `preferred_username`, `email` o `upn`, en ese orden.
