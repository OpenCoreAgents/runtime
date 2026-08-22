/** Browser-compatible hydrator for `AgentRuntime.dynamicDefinitionsHydrator`. */
export async function hydrateBrowserDynamicDefinitions(
  store: unknown,
  projectId: string,
  agentId: string,
  options?: { secrets?: Record<string, string> },
): Promise<void> {
  const { hydrateAgentDefinitionsFromStore } = await import(
    "@opencoreagents/dynamic-definitions"
  );
  await hydrateAgentDefinitionsFromStore(
    store as Parameters<typeof hydrateAgentDefinitionsFromStore>[0],
    projectId,
    agentId,
    options,
  );
}
