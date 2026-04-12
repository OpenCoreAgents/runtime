import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@opencoreagents/core";
import {
  clearAllRegistriesForTests,
  InMemoryMemoryAdapter,
  resolveToolRegistry,
  ToolRunner,
} from "@opencoreagents/core";
import { createHttpToolAdapter } from "../src/createHttpToolAdapter.js";
import { registerHttpToolsFromDefinitions } from "../src/register.js";

const toolCtx = (): ToolContext => ({
  projectId: "acme",
  agentId: "a1",
  runId: "r1",
  sessionId: "s1",
  memoryAdapter: new InMemoryMemoryAdapter(),
  securityContext: {
    principalId: "x",
    kind: "internal",
    organizationId: "o1",
    projectId: "acme",
    roles: ["agent"],
    scopes: ["*"],
  },
});

describe("createHttpToolAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs JSON body and returns parsed JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "",
      json: async () => ({ id: "42" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHttpToolAdapter(
      {
        id: "lookup",
        projectId: "acme",
        http: {
          method: "POST",
          url: "https://api.example.com/lookup",
          bodyFromInput: { email: "{{input.email}}" },
        },
      },
      {},
    );

    const out = await adapter.execute({ email: "u@x.com" }, toolCtx());
    expect(out).toEqual({ id: "42" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/lookup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "u@x.com" }),
      }),
    );
  });

  it("applies GET query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "",
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createHttpToolAdapter({
      id: "q",
      projectId: "acme",
      http: {
        method: "GET",
        url: "https://api.example.com/search",
        query: { q: "{{input.q}}" },
      },
    });

    await adapter.execute({ q: "hello world" }, toolCtx());
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(new URL(calledUrl).searchParams.get("q")).toBe("hello world");
  });
});

describe("registerHttpToolsFromDefinitions", () => {
  afterEach(() => {
    clearAllRegistriesForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers definition and handler for ToolRunner", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "",
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await registerHttpToolsFromDefinitions([
      {
        id: "remote_echo",
        projectId: "acme",
        description: "Echo",
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
        http: {
          method: "POST",
          url: "https://echo.example.com/",
          bodyFromInput: { x: "{{input.x}}" },
        },
      },
    ]);

    const registry = resolveToolRegistry("acme");
    const runner = new ToolRunner(registry, new Set(["remote_echo"]));
    const result = await runner.execute("remote_echo", { x: "hi" }, toolCtx());
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });
});
