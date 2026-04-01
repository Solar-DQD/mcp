import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import sql from "mssql";
import * as dotenv from "dotenv";
import { z } from "zod";
import * as http from "http";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// --- Config ------------------------------------------------------------------

const config = JSON.parse(
  readFileSync(resolve(__dirname, "..", "config.json"), "utf-8")
);
const PROYECTOS: Record<string, string[]> = config.proyectos;
const SCHEMA_BASE: string = config.schema_description;

// Schema completo con mapeo de dispositivos inyectado
const SCHEMA_DESCRIPTION = `${SCHEMA_BASE}

== MAPEO DISPOSITIVOS → PROYECTO ==
Los dispositivos (relojes) se agrupan por proyecto. Este mapeo NO está en la DB:
${Object.entries(PROYECTOS).map(([k, v]) => `  ${k}: ${v.length ? v.join(", ") : "(sin dispositivos)"}`).join("\n")}`;

// --- DB -----------------------------------------------------------------------

const dbConfig: sql.config = {
  server: process.env.MSSQL_HOST!,
  port: parseInt(process.env.MSSQL_PORT || "1433"),
  database: process.env.MSSQL_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  options: { trustServerCertificate: true },
};

async function getPool() {
  return sql.connect(dbConfig);
}

// --- Registro de tools -------------------------------------------------------

function registrarTools(server: McpServer) {

  server.tool(
    "listar_proyectos",
    "Lista todos los proyectos de la empresa con sus dispositivos (relojes) asociados.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(PROYECTOS, null, 2) }],
    })
  );

  server.tool(
    "consulta_sql",
    `Ejecuta una consulta SELECT de solo lectura contra la base de datos de asistencia.
Usá esta herramienta para responder cualquier pregunta sobre asistencia, presentes, ausentes, empleados, etc.

${SCHEMA_DESCRIPTION}`,
    {
      query: z.string().describe("Consulta SQL SELECT a ejecutar. Solo se permiten SELECT."),
    },
    async ({ query }) => {
      const trimmed = query.trim();
      if (!/^SELECT\b/i.test(trimmed)) {
        return {
          content: [{ type: "text", text: "Error: Solo se permiten consultas SELECT." }],
          isError: true,
        };
      }
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|DENY)\b/i.test(trimmed)) {
        return {
          content: [{ type: "text", text: "Error: La consulta contiene operaciones no permitidas." }],
          isError: true,
        };
      }

      const pool = await getPool();
      try {
        const result = await pool.request().query(trimmed);
        await pool.close();
        return {
          content: [{ type: "text", text: JSON.stringify({
            filas: result.recordset.length,
            datos: result.recordset,
          })}],
        };
      } catch (err: any) {
        await pool.close();
        return {
          content: [{ type: "text", text: `Error SQL: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

// --- HTTP Server --------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  if (req.url === `/${process.env.SECRET_PATH}` && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    // Log headers para descubrir qué envía Claude sobre el usuario
    console.log("=== REQUEST HEADERS ===");
    console.log(JSON.stringify(req.headers, null, 2));
    console.log("=======================");

    const server = new McpServer({ name: "mcp-asistencia", version: "1.0.0" });
    registrarTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("Error manejando request MCP:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    } finally {
      await server.close();
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = parseInt(process.env.PORT || "3000");
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP asistencia corriendo en http://0.0.0.0:${PORT}/mcp`);
});
