/**
 * Custom tools for Port 2 (agentic sessions).
 *
 * Verified detail from the brief: custom tools on the Agent SDK are
 * in-process SDK MCP servers, built with `tool()` + `createSdkMcpServer()`
 * and addressed as `mcp__{server}__{tool}` in `allowedTools`. That is an
 * `@anthropic-ai/claude-agent-sdk` API, and "no package outside
 * `@shadow/model` may import an AI SDK" (D5) — so if `@shadow/research` or
 * `@shadow/agent` need a custom tool, this module is the only legal path:
 * it wraps `tool()`/`createSdkMcpServer()` once, here, and hands callers an
 * opaque `ToolServerHandle` they pass back into
 * `AgenticSessionOptions.toolServers` without ever touching the Agent SDK
 * themselves.
 *
 * Deliberately narrow: text-only tool results. That covers the large
 * majority of tool-agent use cases (research findings, structured
 * summaries serialized to text, status strings) and can grow to cover
 * images/resources later without a breaking change to `ToolResult` — no
 * caller depends on the union being closed.
 */

import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { ZodType, z } from "zod";

/** The result a tool handler returns. Text-only — see the module doc for why. */
export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolDefinition<Shape extends Record<string, ZodType>> {
  readonly name: string;
  readonly description: string;
  /** A plain object of Zod schemas — the tool's input shape, e.g. `{ query: z.string() }`. */
  readonly inputSchema: Shape;
  readonly handler: (input: { [K in keyof Shape]: z.infer<Shape[K]> }) => Promise<ToolResult>;
}

/**
 * An in-process MCP tool server, ready to hand to
 * `AgenticSessionOptions.toolServers`. Opaque by design (see module doc) —
 * `name` and `toolNames` are exposed only so a caller can build its own
 * `allowedTools` list (`mcp__{name}__{toolName}`) without hardcoding the
 * naming convention twice.
 */
export interface ToolServerHandle {
  readonly name: string;
  readonly toolNames: readonly string[];
}

/** `ToolServerHandle` plus the real Agent SDK config, visible only inside this package. */
export interface ResolvedToolServerHandle extends ToolServerHandle {
  readonly config: unknown;
}

/** Define one tool. Pass the result to `createToolServer` to make it callable. */
export function defineTool<Shape extends Record<string, ZodType>>(
  definition: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return definition;
}

/**
 * Bundle one or more `defineTool` definitions into an in-process MCP
 * server. The Agent SDK addresses each tool as
 * `mcp__{serverName}__{toolName}` — include those names in
 * `AgenticSessionOptions.allowedTools` to actually enable them (a defined
 * tool the model isn't allowed to call is inert, by design — the same
 * allow-list discipline as every other tool on this port).
 */
export function createToolServer(
  serverName: string,
  // `ToolDefinition<Shape>` puts `Shape` in `handler`'s parameter position,
  // so it is invariant — no single concrete instantiation can describe a
  // heterogeneous array of differently-shaped tools. `any` here is the
  // deliberate, standard way to box that (the same pattern as, e.g., a
  // React element array over components with different prop types): full
  // type safety still holds at each `defineTool` call site, and every use
  // inside this function treats the shape opaquely (name/description
  // passthrough, `handler` invoked with whatever the caller's own schema
  // validated).
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  tools: ReadonlyArray<ToolDefinition<any>>,
): ResolvedToolServerHandle {
  const sdkTools = tools.map((definition) =>
    sdkTool(definition.name, definition.description, definition.inputSchema, async (args) => {
      const result = await definition.handler(args);
      return {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      };
    }),
  );

  const config = createSdkMcpServer({ name: serverName, tools: sdkTools });

  return {
    name: serverName,
    toolNames: tools.map((definition) => definition.name),
    config,
  };
}
