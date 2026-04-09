/** Optional host policy for the `system_send_message` tool — return `false` to deny. */
export type SendMessageTargetPolicy = (input: {
  fromAgentId: string;
  toAgentId: string;
  projectId: string;
  sessionId: string;
  endUserId?: string;
}) => boolean;
