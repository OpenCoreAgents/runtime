/**
 * Effective allowlist: explicit non-empty list, or the single hostname from `resolvedUrl`.
 */
export function resolveAllowedHostnames(
  resolvedUrl: string,
  explicit?: string[],
): string[] {
  const hostname = new URL(resolvedUrl).hostname;
  if (explicit != null && explicit.length > 0) {
    return explicit;
  }
  return [hostname];
}

export function assertUrlHostAllowed(resolvedUrl: string, explicit?: string[]): void {
  const hostname = new URL(resolvedUrl).hostname;
  const allowed = resolveAllowedHostnames(resolvedUrl, explicit);
  if (!allowed.includes(hostname)) {
    throw new Error(
      `HTTP tool: host "${hostname}" is not allowed (allowed: ${allowed.join(", ")})`,
    );
  }
}
