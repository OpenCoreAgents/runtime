/** Dynamic definition hydration is intentionally not bundled into the browser core artifact. */
export async function hydrateDynamicDefinitions(): Promise<void> {
  throw new Error(
    "dynamicDefinitionsStore is not supported by the browser core artifact. Define agents in-process before loading them.",
  );
}
