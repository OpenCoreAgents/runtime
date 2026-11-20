import { randomUUID } from "node:crypto";

export function hasRuntimeEnv(): boolean {
  return true;
}

export function readRuntimeEnv(name: string): string | undefined {
  return process.env[name];
}

export function createRandomUuid(): string {
  return randomUUID();
}
