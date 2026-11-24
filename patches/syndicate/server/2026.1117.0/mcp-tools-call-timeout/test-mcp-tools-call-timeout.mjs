// Focused check for the SYN-813 patch: the MCP-protocol route must pass the
// caller's timeout into executeTool, and a connection must be able to agree a
// longer budget for its own tools.
//
// Run: node --test test-mcp-tools-call-timeout.mjs
// The dist under test is taken from PAPERCLIP_SERVER_DIST (default: the active
// @paperclipai/server install).
import test from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

async function serverDist() {
  if (process.env.PAPERCLIP_SERVER_DIST)
    return process.env.PAPERCLIP_SERVER_DIST;
  const cliRoot = "/root/.paperclip/cli/current/node_modules/@paperclipai/server";
  return path.join(await realpath(cliRoot), "dist");
}

const dist = await serverDist();
const serverRequire = createRequire(path.join(dist, "..", "package.json"));
const express = serverRequire("express");
const { mcpGatewayProtocolRoutes } = await import(path.join(dist, "routes", "tool-gateway.js"));
const serviceModule = await import(path.join(dist, "services", "tool-gateway.js"));
const connectionToolTimeoutMs = serviceModule.connectionToolTimeoutMs;

async function withGateway(gateway, run) {
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}/mcp/gateways/gw_test`);
  }
  finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function callMcpTools(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

test("MCP tools/call passes the caller's timeout into executeTool", async () => {
  const received = [];
  await withGateway({
    executeTool: async (input) => {
      received.push(input);
      return { result: { content: "ok", data: { ok: true } } };
    },
  }, async (url) => {
    const { status, payload } = await callMcpTools(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slow_tool", arguments: { a: 1 } },
      timeoutMs: 60_000,
    });
    assert.equal(status, 200);
    assert.equal(payload.result.isError, false);
    assert.equal(received.length, 1);
    assert.equal(received[0].timeoutMs, 60_000);
    assert.equal(received[0].tool, "slow_tool");
    assert.deepEqual(received[0].parameters, { a: 1 });
  });
});

test("MCP tools/call without a timeout keeps the default path", async () => {
  const received = [];
  await withGateway({
    executeTool: async (input) => {
      received.push(input);
      return { result: { content: "ok", data: { ok: true } } };
    },
  }, async (url) => {
    const { status } = await callMcpTools(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "quick_tool", arguments: {} },
    });
    assert.equal(status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].timeoutMs, undefined);
  });
});

test("a connection agrees a longer budget for its own tools", () => {
  assert.equal(typeof connectionToolTimeoutMs, "function", "patched service must export connectionToolTimeoutMs");
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: 60_000 } }, {}), 60_000);
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: 15_000 } }, {}), 15_000);
});

test("without a configured budget the default path is unchanged", () => {
  assert.equal(connectionToolTimeoutMs({ config: {} }, {}), undefined);
  assert.equal(connectionToolTimeoutMs({ config: { templateId: "x" } }, {}), undefined);
  assert.equal(connectionToolTimeoutMs({}, {}), undefined);
  assert.equal(connectionToolTimeoutMs(undefined, {}), undefined);
});

test("a configured budget is clamped to the gateway ceiling", () => {
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: 999_999 } }, {}), 60_000);
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: 0 } }, {}), 1);
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: -5 } }, {}), 1);
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: "60000" } }, {}), undefined);
  assert.equal(connectionToolTimeoutMs({ config: { toolTimeoutMs: Number.NaN } }, {}), undefined);
});
