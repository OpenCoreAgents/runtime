/** Optional peer; runtime `import()` only when `dynamicDefinitionsStore` is set. DTS must not require the package at build time. */
declare module "@opencoreagents/dynamic-definitions" {
  export function hydrateAgentDefinitionsFromStore(
    store: unknown,
    projectId: string,
    agentId: string,
    options?: { secrets?: Record<string, string> },
  ): Promise<void>;
}
