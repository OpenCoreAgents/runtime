/**
 * Loads OpenClaw-style SKILL.md skills from ../skills, registers `exec`,
 * merges skill instructions into the system prompt (core ContextBuilder does not
 * yet append skill descriptions), and runs a short scripted loop that calls `exec`.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";
import {
  Agent,
  AgentRuntime,
  Session,
  InMemoryMemoryAdapter,
  getSkillDefinition,
} from "@opencoreagents/core";
import { loadOpenClawSkills, registerOpenClawExecTool } from "@opencoreagents/skill-loader-openclaw";

/** Tenant / project id for definitions, session, and skill resolution. */
const PROJECT_ID = "demo-openclaw";

/** Parent folder: each subfolder with a SKILL.md is one OpenClaw skill. */
const skillsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Builds extra system text from registered skills (ContextBuilder does not inject skill bodies today). */
function openClawSkillPromptBlock(skillIds: string[]): string {
  const parts: string[] = [];
  for (const id of skillIds) {
    const sk = getSkillDefinition(PROJECT_ID, id);
    if (sk?.description) {
      parts.push(`### Skill \`${id}\`\n${sk.description}`);
    }
  }
  if (!parts.length) return "";
  return `\n\n## Loaded OpenClaw skills\n${parts.join("\n\n")}`;
}

/** Fixed sequence of Step JSON objects so the run completes without a real LLM. */
class DemoScriptLlm implements LLMAdapter {
  private i = 0;
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    const steps = [
      // Step 1 — protocol “think” turn (no side effects).
      JSON.stringify({
        type: "thought",
        content: "User wants the OpenClaw demo; follow skill openclaw_demo and call exec.",
      }),
      // Step 2 — invoke the exec tool (matches what openclaw_demo SKILL.md describes).
      JSON.stringify({
        type: "action",
        tool: "exec",
        input: { command: "node -p 42" },
      }),
      // Step 3 — final answer after the engine appends the tool observation to history.
      JSON.stringify({
        type: "result",
        content:
          "OpenClaw demo finished: exec ran node -p 42; check observation for stdout 42.",
      }),
    ];
    // Advance one scripted response per engine LLM call; extra calls get a harmless result.
    const content = steps[this.i++] ?? JSON.stringify({ type: "result", content: "done" });
    return { content };
  }
}

async function main(): Promise<void> {
  // 1. Parse SKILL.md files, run gates, register each eligible skill via Skill.define.
  const { loaded, skipped } = await loadOpenClawSkills({
    dirs: [skillsRoot],
    onLoaded: (name) => console.log(`[openclaw] loaded skill: ${name}`),
    onSkipped: (name, reason) => console.log(`[openclaw] skipped skill: ${name} — ${reason}`),
    onSkillParseError: (p, err) =>
      console.warn(`[openclaw] SKILL.md parse failed: ${p}`, err),
  });

  // 2. Log load outcome (e.g. gated_missing_bin skipped, openclaw_demo loaded).
  console.log(`[openclaw] summary: ${loaded.length} loaded, ${skipped.length} skipped`);

  // 3. Register the shell-less exec tool OpenClaw skills expect.
  await registerOpenClawExecTool();

  // 4. Base system instructions plus inlined skill text for the model.
  const basePrompt =
    "You are a demo agent. Follow the JSON Step protocol. " +
    "When skills apply, obey their instructions.";

  // 5. Agent: allow exec, attach loaded skill ids for allowlist / future context behavior.
  await Agent.define({
    id: "openclaw-demo-agent",
    projectId: PROJECT_ID,
    systemPrompt: basePrompt + openClawSkillPromptBlock(loaded),
    tools: ["exec"],
    skills: loaded,
    llm: { provider: "openai", model: "gpt-4o-mini" },
  });

  // 6. Runtime: mock LLM + in-process memory (not durable across restarts).
  const runtime = new AgentRuntime({
    llmAdapter: new DemoScriptLlm(),
    memoryAdapter: new InMemoryMemoryAdapter(),
    maxIterations: 10,
  });

  // 7. Session ties the run to projectId (and optional fileReadRoot / sessionContext in real apps).
  const session = new Session({
    id: "openclaw-session-1",
    projectId: PROJECT_ID,
  });

  // 8. Bind agent definition + runtime + session, then execute one user turn.
  const agent = await Agent.load("openclaw-demo-agent", runtime, { session });
  const run = await agent.run("Run the OpenClaw demo skill.");

  // 9. Inspect final run: status, tool observation, closing result step.
  console.log("run status:", run.status);
  for (const h of run.history) {
    if (h.type === "observation") {
      console.log("observation:", JSON.stringify(h.content, null, 2));
    }
  }
  const result = run.history.find((h) => h.type === "result");
  if (result && typeof result.content === "string") {
    console.log("result:", result.content);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
