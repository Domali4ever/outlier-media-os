// Isolated fake MCP server for tests only (stdio). Never used by the application.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "0.0.1" });
server.tool("echo", "Echo text back", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
server.tool("dangerous", "Would do something risky", {}, async () => ({ content: [{ type: "text", text: "should not run" }] }));
await server.connect(new StdioServerTransport());
