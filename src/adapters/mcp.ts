import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDb } from "@/core/db";
import { audit } from "@/core/audit";
import { getSecret } from "@/core/settings";
import { AppError, assert, newId, nowIso, parseJson, redact, truncate } from "@/core/util";
import { ProviderError } from "./http";

/**
 * MCP client: this app's OWN registry of MCP servers. Connectors available inside chat apps are not
 * available here — each server must be configured and authorized for this application.
 * Transports: Streamable HTTP and stdio. Tool calls are allowlisted per server with a permission level.
 */
export interface McpServerRow {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args_json: string;
  header_refs_json: string;
  env_refs_json: string;
  state: string;
  tools_json: string;
  allowlist_json: string;
  last_error: string | null;
  last_test_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listMcpServers(): McpServerRow[] {
  return getDb().prepare("SELECT * FROM mcp_servers ORDER BY created_at").all() as McpServerRow[];
}
export function getMcpServer(id: string): McpServerRow {
  const s = getDb().prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | undefined;
  if (!s) throw new AppError("NOT_FOUND", "MCP server not found", 404);
  return s;
}

export function addMcpServer(
  i: { name: string; transport: "http" | "stdio"; url?: string; command?: string; args?: string[]; headerRefs?: Record<string, string>; envRefs?: Record<string, string> },
  actor: string,
): string {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator registers MCP servers.", 403);
  assert(i.name.trim().length > 1, "BAD_INPUT", "Name is required.");
  assert(i.transport === "http" || i.transport === "stdio", "BAD_INPUT", "Transport must be http or stdio.");
  if (i.transport === "http") {
    assert(i.url, "BAD_INPUT", "URL is required for http transport.");
    const u = new URL(i.url);
    assert(u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname), "BAD_URL", "Remote MCP servers must use https.");
  } else assert(i.command && i.command.trim(), "BAD_INPUT", "Command is required for stdio transport.");
  for (const v of Object.values({ ...(i.headerRefs ?? {}), ...(i.envRefs ?? {}) }))
    assert(/^[A-Z][A-Z0-9_]*$/.test(v), "BAD_INPUT", "Header/env values must be environment variable NAMES, not secret values.");
  const id = newId("mcp");
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, name, transport, url, command, args_json, header_refs_json, env_refs_json, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'CONFIGURING', ?, ?)`,
    )
    .run(id, i.name.trim(), i.transport, i.url ?? null, i.command ?? null, JSON.stringify(i.args ?? []), JSON.stringify(i.headerRefs ?? {}), JSON.stringify(i.envRefs ?? {}), nowIso(), nowIso());
  audit({ actor, action: "mcp.add", subjectType: "mcp", subjectId: id, summary: `MCP server “${i.name.trim()}” registered (${i.transport})` });
  return id;
}

function resolveRefs(refs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, ref] of Object.entries(refs)) {
    const v = getSecret(ref);
    if (!v) throw new ProviderError({ provider: "mcp", code: "NOT_CONFIGURED", message: `Environment value ${ref} is not set`, auth: true });
    out[k] = v;
  }
  return out;
}

async function connect(s: McpServerRow): Promise<Client> {
  const client = new Client({ name: "outlier-media-os", version: "1.0.0" });
  if (s.transport === "http") {
    const headers = resolveRefs(parseJson(s.header_refs_json, {}));
    const t = new StreamableHTTPClientTransport(new URL(s.url!), { requestInit: { headers } });
    await client.connect(t);
  } else {
    const env = resolveRefs(parseJson(s.env_refs_json, {}));
    const t = new StdioClientTransport({ command: s.command!, args: parseJson<string[]>(s.args_json, []), env: { PATH: process.env.PATH ?? "", ...env } });
    await client.connect(t);
  }
  return client;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new ProviderError({ provider: "mcp", code: "TIMEOUT", message: `${what} timed out`, retryable: true })), ms)))]).finally(() => clearTimeout(t));
}

/** Capability discovery: lists the server's tools and records them. Allowlist is left unchanged. */
export async function discoverTools(id: string, actor: string) {
  const s = getMcpServer(id);
  if (s.state === "DISABLED" || s.state === "PAUSED") throw new AppError("BAD_STATE", `Server is ${s.state}.`);
  getDb().prepare("UPDATE mcp_servers SET state='TESTING', updated_at=? WHERE id=?").run(nowIso(), id);
  let client: Client | null = null;
  try {
    client = await withTimeout(connect(s), 20_000, "MCP connect");
    const r = await withTimeout(client.listTools(), 20_000, "tools/list");
    const tools = r.tools.map((t) => ({ name: t.name, description: truncate(t.description ?? "", 300), annotations: t.annotations ?? null }));
    getDb().prepare("UPDATE mcp_servers SET state='CONNECTED', tools_json=?, last_error=NULL, last_test_at=?, updated_at=? WHERE id=?").run(JSON.stringify(tools), nowIso(), nowIso(), id);
    audit({ actor, action: "mcp.discover", subjectType: "mcp", subjectId: id, summary: `MCP “${s.name}”: ${tools.length} tool(s) discovered` });
    return tools;
  } catch (e) {
    const msg = redact((e as Error).message);
    getDb().prepare("UPDATE mcp_servers SET state=?, last_error=?, last_test_at=?, updated_at=? WHERE id=?").run(s.state === "CONNECTED" ? "DEGRADED" : "CONFIGURING", msg, nowIso(), nowIso(), id);
    throw e instanceof ProviderError ? e : new ProviderError({ provider: "mcp", code: "MCP_ERROR", message: msg, retryable: true });
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export function setAllowlist(id: string, tool: string, level: number | null, actor: string) {
  if (actor !== "operator") throw new AppError("PERMISSION", "Only the operator changes MCP allowlists.", 403);
  const s = getMcpServer(id);
  const tools = parseJson<{ name: string }[]>(s.tools_json, []);
  assert(tools.some((t) => t.name === tool), "BAD_INPUT", "Tool not discovered on this server.");
  const al = parseJson<Record<string, number>>(s.allowlist_json, {});
  if (level === null) delete al[tool];
  else {
    assert([0, 1, 2, 3].includes(level), "BAD_INPUT", "Level must be 0–3; Level 4 actions are never delegated to tools.");
    al[tool] = level;
  }
  getDb().prepare("UPDATE mcp_servers SET allowlist_json=?, updated_at=? WHERE id=?").run(JSON.stringify(al), nowIso(), id);
  audit({ actor, action: "mcp.allowlist", subjectType: "mcp", subjectId: id, summary: `MCP “${s.name}”: ${tool} ${level === null ? "removed from allowlist" : `allowed at level ${level}`}` });
}

export function setMcpState(id: string, state: "PAUSED" | "DISABLED" | "CONFIGURING", actor: string) {
  const s = getMcpServer(id);
  getDb().prepare("UPDATE mcp_servers SET state=?, updated_at=? WHERE id=?").run(state, nowIso(), id);
  audit({ actor, action: "mcp.state", subjectType: "mcp", subjectId: id, summary: `MCP “${s.name}” → ${state}` });
}

/**
 * Calls an allowlisted tool. The caller's permission level must be >= the tool's allowlisted level.
 * Results are untrusted data and are returned as text only.
 */
export async function callTool(id: string, tool: string, args: Record<string, unknown>, callerLevel: number): Promise<{ text: string; isError: boolean }> {
  const s = getMcpServer(id);
  if (s.state !== "CONNECTED") throw new ProviderError({ provider: "mcp", code: "NOT_CONNECTED", message: `MCP server ${s.name} is ${s.state}`, auth: true });
  const al = parseJson<Record<string, number>>(s.allowlist_json, {});
  if (!(tool in al)) throw new AppError("NOT_ALLOWLISTED", `${tool} is not allowlisted on ${s.name}.`, 403);
  if (callerLevel < al[tool]) throw new AppError("PERMISSION", `${tool} requires level ${al[tool]}; caller has ${callerLevel}.`, 403);
  const client = await withTimeout(connect(s), 20_000, "MCP connect");
  try {
    const r = (await withTimeout(client.callTool({ name: tool, arguments: args }), 60_000, `tools/call ${tool}`)) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content omitted]`)).join("\n");
    return { text: truncate(text, 50_000), isError: !!r.isError };
  } finally {
    await client.close().catch(() => undefined);
  }
}
