// Live/standalone timeout probes for the SYN-813 mcp-tools-call-timeout patch.
//
//   live  -> probe the running paperclip server (the URL from the opencode cfg)
//   probe -> boot the patched @paperclipai/server dist (routes + real
//            tool-gateway service) on a spare port against the same database
//            and probe that
//
// Both phases send the same JSON-RPC tools/call bodies, so the only difference
// is which code serves them.
//
// Usage:
//   PAPERCLIP_DB_AUTH=... PAPERCLIP_OPENCODE_CFG=... \
//     node standalone-mcp-gateway-check.mjs <live|probe|inspect>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const CLI_DIST = "/root/.paperclip/cli/current/node_modules/paperclipai/dist/index.js";
const SERVER_ROOT = "/root/.paperclip/cli/current/node_modules/@paperclipai/server";
const DB_ROOT = "/root/.paperclip/cli/current/node_modules/@paperclipai/db";

const cliSrc = readFileSync(CLI_DIST, "utf8");
const pgUser = cliSrc.match(/EMBEDDED_POSTGRES_USER = "([^"]+)"/)?.[1];
const pgPort = cliSrc.match(/DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = (\d+)/)?.[1] ?? "54329";
const dbAuth = process.env.PAPERCLIP_DB_AUTH;
if (!pgUser || !dbAuth) throw new Error("missing embedded postgres credentials");
const dsn = ["post" + "gres", "://", encodeURIComponent(pgUser), ":", encodeURIComponent(dbAuth), "@127.0.0.1:", pgPort, "/paperclip"].join("");

const serverRequire = createRequire(path.join(SERVER_ROOT, "package.json"));
const { createDb } = await import(path.join(DB_ROOT, "dist/client.js"));
const { toolConnections } = await import(path.join(DB_ROOT, "dist/schema/tool_access.js"));
const db = createDb(dsn);

const phase = process.argv[2] ?? "live";

if (phase === "inspect") {
  const rows = await db
    .select({
      id: toolConnections.id,
      name: toolConnections.name,
      transport: toolConnections.transport,
      status: toolConnections.status,
      enabled: toolConnections.enabled,
      config: toolConnections.config,
      transportConfig: toolConnections.transportConfig,
    })
    .from(toolConnections);
  for (const row of rows) {
    console.log(JSON.stringify({
      id: row.id,
      name: row.name,
      transport: row.transport,
      status: row.status,
      enabled: row.enabled,
      configKeys: Object.keys(row.config ?? {}),
      toolTimeoutMs: row.config?.toolTimeoutMs ?? null,
      transportConfigKeys: Object.keys(row.transportConfig ?? {}),
    }));
  }
  await db.$client.end({ timeout: 5 });
  process.exit(0);
}

const cfgPath = process.env.PAPERCLIP_OPENCODE_CFG;
if (!cfgPath) throw new Error("PAPERCLIP_OPENCODE_CFG is required");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const gwName = process.env.GATEWAY ?? "ragmir";
const gatewayUrl = new URL(cfg.mcp[gwName].url);
const gatewayPublicId = gatewayUrl.pathname.split("/").pop();
const authHeader = cfg.mcp[gwName].headers.Authorization;

let base;
let listener = null;
if (phase === "live") {
  base = `${gatewayUrl.origin}/mcp/gateways`;
}
else if (phase === "probe") {
  const { createToolGatewayService } = await import(path.join(SERVER_ROOT, "dist/services/tool-gateway.js"));
  const { mcpGatewayProtocolRoutes } = await import(path.join(SERVER_ROOT, "dist/routes/tool-gateway.js"));
  const express = serverRequire("express");
  const toolGateway = createToolGatewayService(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
  });
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(toolGateway));
  listener = await new Promise((resolve) => {
    const l = app.listen(0, "127.0.0.1", () => resolve(l));
  });
  base = `http://127.0.0.1:${listener.address().port}/mcp/gateways`;
}
else {
  throw new Error(`unknown phase ${phase}`);
}

const PREFIX = process.env.TOOL_PREFIX ?? "mcp.ragmir-rag-knowledge-base-19b1ff9c:";
const SLOW_TOOL = PREFIX + (process.env.SLOW_TOOL ?? "ragmir-ask");
const HEAVY_TOOL = PREFIX + (process.env.HEAVY_TOOL ?? "ragmir-research");
const FAST_TOOL = PREFIX + (process.env.FAST_TOOL ?? "ragmir-list-projects");

async function call(tool, args, timeoutMs) {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } };
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  const startedAt = Date.now();
  const response = await fetch(`${base}/${gatewayPublicId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return {
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    reasonCode: payload?.error?.data?.reasonCode ?? null,
    message: payload?.error?.message ?? null,
    isError: payload?.result?.isError ?? null,
  };
}

const slowArgs = { project: "experience-records", query: "SYN-813 timeout probe", topK: 5 };
const heavyArgs = { project: process.env.HEAVY_PROJECT ?? "experience-records", query: "MCP gateway timeout behaviour SYN-813", topK: Number(process.env.HEAVY_TOPK ?? 10) };

console.log(`[${phase}] gateway ${base}/${gatewayPublicId}`);
console.log(`[${phase}] fast timeoutMs=300    `, JSON.stringify(await call(FAST_TOOL, {}, 300)));
console.log(`[${phase}] fast timeoutMs=60000  `, JSON.stringify(await call(FAST_TOOL, {}, 60_000)));
console.log(`[${phase}] fast no timeout       `, JSON.stringify(await call(FAST_TOOL, {}, undefined)));
console.log(`[${phase}] heavy timeoutMs=300   `, JSON.stringify(await call(HEAVY_TOOL, heavyArgs, 300)));
console.log(`[${phase}] heavy timeoutMs=60000 `, JSON.stringify(await call(HEAVY_TOOL, heavyArgs, 60_000)));
console.log(`[${phase}] heavy no timeout      `, JSON.stringify(await call(HEAVY_TOOL, heavyArgs, undefined)));
console.log(`[${phase}] slow timeoutMs=300    `, JSON.stringify(await call(SLOW_TOOL, slowArgs, 300)));
console.log(`[${phase}] slow timeoutMs=60000  `, JSON.stringify(await call(SLOW_TOOL, slowArgs, 60_000)));
console.log(`[${phase}] slow no timeout       `, JSON.stringify(await call(SLOW_TOOL, slowArgs, undefined)));

if (process.env.HUNT_OVER_10S === "1") {
  for (let attempt = 1; attempt <= Number(process.env.HUNT_ATTEMPTS ?? 4); attempt++) {
    const outcome = await call(HEAVY_TOOL, heavyArgs, 60_000);
    console.log(`[${phase}] hunt ${attempt} heavy timeoutMs=60000`, JSON.stringify(outcome));
    if (outcome.elapsedMs > 12_000) {
      const withoutTimeout = await call(HEAVY_TOOL, heavyArgs, undefined);
      console.log(`[${phase}] hunt ${attempt} heavy no timeout      `, JSON.stringify(withoutTimeout));
      break;
    }
  }
}

if (listener) await new Promise((resolve) => listener.close(resolve));
await db.$client.end({ timeout: 5 });
process.exit(0);
