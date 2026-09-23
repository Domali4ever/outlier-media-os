import path from "node:path";
import { describe, expect, it } from "vitest";
import { addMcpServer, callTool, discoverTools, getMcpServer, setAllowlist } from "@/adapters/mcp";
import { freshDb } from "./helpers";

describe("MCP client (local stdio fake server — test only)", () => {
  it("discovers tools, enforces the allowlist and permission level", async () => {
    freshDb();
    expect(() => addMcpServer({ name: "bad server", transport: "http", url: "https://m.example", headerRefs: { Authorization: "sk-live-value" } }, "operator")).toThrow(/NAMES/);
    const id = addMcpServer({ name: "fake", transport: "stdio", command: process.execPath, args: [path.join(__dirname, "fixtures", "fake-mcp-server.mjs")] }, "operator");
    const tools = await discoverTools(id, "operator");
    expect(tools.map((t) => t.name).sort()).toEqual(["dangerous", "echo"]);
    expect(getMcpServer(id).state).toBe("CONNECTED");
    await expect(callTool(id, "echo", { text: "hi" }, 2)).rejects.toThrow(/not allowlisted/);
    setAllowlist(id, "echo", 2, "operator");
    expect(() => setAllowlist(id, "dangerous", 4, "operator")).toThrow(/never delegated/);
    await expect(callTool(id, "echo", { text: "hi" }, 1)).rejects.toThrow(/requires level 2/);
    const r = await callTool(id, "echo", { text: "hi" }, 2);
    expect(r.text).toBe("echo:hi");
  }, 30000);
});
