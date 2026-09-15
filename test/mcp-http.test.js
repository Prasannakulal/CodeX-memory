import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer, createMcpApp } from "../src/server.js";

const TEST_PORT = 39182;

test("Streamable HTTP MCP Server - end-to-end client connection, tools, and error handling", async (t) => {
  const { server, port, transports } = await startHttpServer({
    port: TEST_PORT,
    host: "127.0.0.1",
  });

  t.after(async () => {
    for (const [, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch {}
    }
    transports.clear();
    await new Promise((resolve) => server.close(resolve));
  });

  await t.test("health endpoint returns status ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.server, "codex-memory");
    assert.equal(body.transport, "streamable-http");
  });

  await t.test("client connects via StreamableHTTPClientTransport and lists tools", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );

    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    const toolsResponse = await client.listTools();
    assert.ok(Array.isArray(toolsResponse.tools));
    const searchTool = toolsResponse.tools.find((tool) => tool.name === "search_documents");
    assert.ok(searchTool, "search_documents tool should be registered");
    assert.equal(typeof searchTool.description, "string");
    assert.ok(searchTool.inputSchema.properties.query);

    // Call tool
    const result = await client.callTool({
      name: "search_documents",
      arguments: {
        query: "Prasanna",
        topK: 2,
      },
    });

    assert.ok(result);
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, "text");
    assert.ok(typeof result.content[0].text === "string");

    await client.close();
  });

  await t.test("handles malformed JSON request with standard JSON-RPC parse error", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{ not valid json",
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32700);
    assert.ok(body.error.message.includes("Parse error"));
  });

  await t.test("rejects request with invalid session ID with 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "non-existent-session-id",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32001);
  });

  await t.test("rejects request without session ID and not initialize with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32000);
  });
});

test("Streamable HTTP MCP Server - Authentication enforcement", async (t) => {
  const AUTH_PORT = 39183;
  const SECRET_TOKEN = "secret-mcp-key-12345";

  const { server, port, transports } = await startHttpServer({
    port: AUTH_PORT,
    host: "127.0.0.1",
    authToken: SECRET_TOKEN,
  });

  t.after(async () => {
    for (const [, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch {}
    }
    transports.clear();
    await new Promise((resolve) => server.close(resolve));
  });

  await t.test("rejects unauthenticated request with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
        id: 1,
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32000);
    assert.ok(body.error.message.includes("Unauthorized"));
  });

  await t.test("accepts request with valid Bearer token", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${SECRET_TOKEN}`,
          },
        },
      }
    );

    const client = new Client(
      { name: "auth-test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0);
    await client.close();
  });
});

import { closeIngestionQueue } from "../src/queue.js";

test("Control Center Dashboard & REST API", async (t) => {
  const CC_PORT = 39184;
  const { server, port, transports } = await startHttpServer({
    port: CC_PORT,
    host: "127.0.0.1",
  });

  t.after(async () => {
    for (const [, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch {}
    }
    transports.clear();
    await new Promise((resolve) => server.close(resolve));
    await closeIngestionQueue();
  });

  await t.test("serves Control Center HTML dashboard on GET /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("CODEX"));
    assert.ok(html.includes("QUICK NOTE INGESTION"));
    assert.ok(html.includes("VECTOR SEARCH PLAYGROUND"));
  });

  await t.test("GET /api/status returns subsystem health", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "online");
    assert.ok(body.redis);
    assert.ok(body.ollama);
    assert.ok(body.queue);
    assert.ok(body.mcp);
  });

  await t.test("GET /api/documents returns list of documents", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/documents`);
    assert.equal(res.status, 200);
    const docs = await res.json();
    assert.ok(Array.isArray(docs));
  });

  await t.test("POST /api/documents/note creates note and DELETE removes it", async () => {
    const testTitle = "temp-control-center-test";
    const postRes = await fetch(`http://127.0.0.1:${port}/api/documents/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: testTitle,
        content: "# Test Note\nThis is an automated test note for the Control Center.",
      }),
    });

    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(postBody.success, true);
    assert.equal(postBody.filename, `${testTitle}.md`);

    // Clean up
    const delRes = await fetch(`http://127.0.0.1:${port}/api/documents/${testTitle}.md`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.equal(delBody.success, true);
  });

  await t.test("POST /api/search runs vector search", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Prasanna", topK: 2 }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.results));
  });
});
