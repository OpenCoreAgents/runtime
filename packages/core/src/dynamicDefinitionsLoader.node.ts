export async function hydrateDynamicDefinitions(
  store: unknown,
  projectId: string,
  agentId: string,
  secrets: Record<string, string>,
): Promise<void> {
  const { hydrateAgentDefinitionsFromStore } = (await import(
    /* Optional: install `@opencoreagents/dynamic-definitions` when using `dynamicDefinitionsStore`. */
    "@opencoreagents/dynamic-definitions"
  )) as {
    hydrateAgentDefinitionsFromStore: (
      store: unknown,
      projectId: string,
      agentId: string,
      options?: { secrets?: Record<string, string> },
    ) => Promise<void>;
  };
  await hydrateAgentDefinitionsFromStore(store, projectId, agentId, { secrets });
}
