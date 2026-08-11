import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createToolServer, defineTool } from "./tools.ts";

describe("defineTool", () => {
  test("is an identity helper — it exists for type inference, not transformation", () => {
    const definition = defineTool({
      name: "search",
      description: "Search the volume",
      inputSchema: { query: z.string() },
      handler: async ({ query }) => ({ content: `found: ${query}` }),
    });
    expect(definition.name).toBe("search");
    expect(definition.description).toBe("Search the volume");
  });
});

describe("createToolServer", () => {
  test("returns a handle naming the server and every tool on it", () => {
    const search = defineTool({
      name: "search",
      description: "Search the volume",
      inputSchema: { query: z.string() },
      handler: async ({ query }) => ({ content: `found: ${query}` }),
    });
    const cite = defineTool({
      name: "cite",
      description: "Look up a citation",
      inputSchema: { id: z.string() },
      handler: async ({ id }) => ({ content: `citation ${id}` }),
    });

    const handle = createToolServer("research", [search, cite]);

    expect(handle.name).toBe("research");
    expect(handle.toolNames).toEqual(["search", "cite"]);
  });

  test("the underlying config is an in-process SDK MCP server config addressed by the server name", () => {
    const tool = defineTool({
      name: "search",
      description: "Search the volume",
      inputSchema: { query: z.string() },
      handler: async ({ query }) => ({ content: `found: ${query}` }),
    });
    const handle = createToolServer("research", [tool]);

    // Structural check against the Agent SDK's McpSdkServerConfigWithInstance
    // shape (`{ type: "sdk", name, instance }`) — the exact wiring
    // `AgenticSessionOptions.toolServers` depends on
    // (`../adapters/claude-agent-sdk-session.ts`), verified without
    // reaching into MCP server internals.
    const config = handle.config as { type: string; name: string; instance: unknown };
    expect(config.type).toBe("sdk");
    expect(config.name).toBe("research");
    expect(config.instance).toBeDefined();
  });

  test("an empty tool list still produces a valid, addressable server", () => {
    const handle = createToolServer("empty-server", []);
    expect(handle.name).toBe("empty-server");
    expect(handle.toolNames).toEqual([]);
  });
});
