import type { LLMAdapter, LLMRequest, LLMResponse } from "@opencoreagents/core";
import {
  IndexedDBMemoryAdapter,
  IndexedDBRunStore,
  IndexedDBDynamicDefinitionsStore,
  deleteOpenCoreBrowserDatabase,
  hydrateBrowserDynamicDefinitions,
} from "@opencoreagents/browser";
import {
  WebLLMAdapter,
  createWebLLMWorkerEngineFactory,
  isWebGpuAvailable,
} from "@opencoreagents/browser/webllm";
import {
  AgentRuntime,
} from "@opencoreagents/core";
import "./style.css";

const projectId = "browser-local-demo";
const agentId = "local-browser-assistant";
const databaseName = "opencoreagents-browser-local-demo";
const sessionStorageKey = "opencoreagents-browser-local-demo-session";
const persistentMemory = new IndexedDBMemoryAdapter({ databaseName });
const persistentRuns = new IndexedDBRunStore({ databaseName });
const persistentDefinitions = new IndexedDBDynamicDefinitionsStore({ databaseName });

function createSessionId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(sessionStorageKey, id);
  return id;
}

let localSessionId = localStorage.getItem(sessionStorageKey) || createSessionId();

class DeterministicBrowserLlm implements LLMAdapter {
  private callCount = 0;

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const isPlanningStep = this.callCount++ % 2 === 0;
    if (isPlanningStep) {
      return {
        content: JSON.stringify({
          type: "thought",
          content: "Prepare a concise answer using only local runtime state.",
        }),
      };
    }

    const latestUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const subject = typeof latestUserMessage === "string" ? latestUserMessage : "the request";

    return {
      content: JSON.stringify({
        type: "result",
        content: `This response was produced entirely in your browser for: “${subject}”`,
      }),
    };
  }
}

const deterministicRuntime = new AgentRuntime({
  llmAdapter: new DeterministicBrowserLlm(),
  memoryAdapter: persistentMemory,
  runStore: persistentRuns,
  dynamicDefinitionsStore: persistentDefinitions,
  dynamicDefinitionsHydrator: hydrateBrowserDynamicDefinitions,
  maxIterations: 5,
});

async function ensureAgentDefinition(): Promise<void> {
  const agents = await persistentDefinitions.listAgents(projectId);
  if (agents.some((agent) => agent.id === agentId)) return;
  await persistentDefinitions.saveAgent(projectId, {
    id: agentId,
    projectId,
    systemPrompt: "You are a concise browser-local assistant.",
    tools: [],
    llm: { provider: "local", model: "browser-selected-model" },
  });
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as T;
}

const form = requireElement<HTMLFormElement>("run-form");
const adapterSelect = requireElement<HTMLSelectElement>("adapter");
const modelField = requireElement<HTMLDivElement>("model-field");
const modelInput = requireElement<HTMLInputElement>("model");
const modelNote = requireElement<HTMLParagraphElement>("model-note");
const prompt = requireElement<HTMLTextAreaElement>("prompt");
const button = requireElement<HTMLButtonElement>("run-button");
const status = requireElement<HTMLSpanElement>("status");
const answer = requireElement<HTMLParagraphElement>("answer");
const history = requireElement<HTMLPreElement>("history");
const progressWrap = requireElement<HTMLDivElement>("progress-wrap");
const progress = requireElement<HTMLProgressElement>("progress");
const progressText = requireElement<HTMLSpanElement>("progress-text");
const localDataStatus = requireElement<HTMLSpanElement>("local-data-status");
const clearLocalData = requireElement<HTMLButtonElement>("clear-local-data");

let webLlmAdapter: WebLLMAdapter | undefined;
let webLlmRuntime: AgentRuntime | undefined;
let loadedWebLlmModel: string | undefined;
let lastWebLlmOutput = "";

function setStatus(label: string, state: "idle" | "running" | "complete" | "error"): void {
  status.textContent = label;
  status.dataset.state = state;
}

function updateAdapterFields(): void {
  const usesWebLlm = adapterSelect.value === "webllm";
  modelField.hidden = !usesWebLlm;
  modelNote.hidden = !usesWebLlm;
  if (!usesWebLlm) progressWrap.hidden = true;
}

async function resolveRuntime(): Promise<AgentRuntime> {
  if (adapterSelect.value !== "webllm") return deterministicRuntime;
  if (!isWebGpuAvailable()) {
    throw new Error("WebGPU is unavailable in this browser. Select the deterministic demo instead.");
  }

  const model = modelInput.value.trim();
  if (!model) throw new Error("Enter a WebLLM model ID.");
  if (webLlmRuntime && loadedWebLlmModel === model) return webLlmRuntime;
  if (webLlmAdapter) await webLlmAdapter.unload();

  progressWrap.hidden = false;
  progress.value = 0;
  webLlmAdapter = new WebLLMAdapter({
    model,
    defaultMaxOutputTokens: 128,
    defaultJsonObjectSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["result"] },
        content: { type: "string", maxLength: 320 },
      },
      required: ["type", "content"],
      additionalProperties: false,
    },
    engineFactory: createWebLLMWorkerEngineFactory(
      () => new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" }),
    ),
    onProgress: (report) => {
      progress.value = report.progress;
      progressText.textContent = `${Math.round(report.progress * 100)}% · ${report.text}`;
      setStatus("Loading local model", "running");
    },
  });
  webLlmRuntime = new AgentRuntime({
    llmAdapter: webLlmAdapter,
    memoryAdapter: persistentMemory,
    runStore: persistentRuns,
    dynamicDefinitionsStore: persistentDefinitions,
    dynamicDefinitionsHydrator: hydrateBrowserDynamicDefinitions,
    maxIterations: 8,
    defaultEngineHooks: {
      onLLMResponse: (response) => {
        lastWebLlmOutput = response.content;
      },
    },
  });
  await webLlmAdapter.initialize();
  loadedWebLlmModel = model;
  progress.value = 1;
  progressText.textContent = "Model ready";
  setStatus("Running locally", "running");
  return webLlmRuntime;
}

adapterSelect.addEventListener("change", updateAdapterFields);
updateAdapterFields();

async function refreshLocalDataStatus(): Promise<void> {
  const runs = await persistentRuns.listByAgent(agentId);
  localDataStatus.textContent = `${runs.length} run${runs.length === 1 ? "" : "s"} stored locally`;
}

clearLocalData.addEventListener("click", async () => {
  if (!window.confirm("Delete all locally stored agent memory and run history for this demo?")) {
    return;
  }
  clearLocalData.disabled = true;
  try {
    await deleteOpenCoreBrowserDatabase(databaseName);
    localStorage.removeItem(sessionStorageKey);
    localSessionId = createSessionId();
    history.textContent = "[]";
    localDataStatus.textContent = "No runs stored locally";
  } catch (error) {
    localDataStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    clearLocalData.disabled = false;
  }
});

void refreshLocalDataStatus().catch((error: unknown) => {
  localDataStatus.textContent = error instanceof Error ? error.message : String(error);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = prompt.value.trim();
  if (!input) return;

  button.disabled = true;
  lastWebLlmOutput = "";
  answer.textContent = "The local agent is working…";
  history.textContent = "[]";
  setStatus("Running locally", "running");

  try {
    await ensureAgentDefinition();
    const runtime = await resolveRuntime();
    const run = await runtime.dispatch({
      kind: "run",
      projectId,
      agentId,
      sessionId: localSessionId,
      userInput: input,
    });
    const result = [...run.history].reverse().find((entry) => entry.type === "result");

    answer.textContent =
      result && typeof result.content === "string" ? result.content : "The run completed without a result.";
    history.textContent = JSON.stringify(run.history, null, 2);
    await refreshLocalDataStatus();
    setStatus("Complete", "complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    answer.textContent = lastWebLlmOutput
      ? `${message}\n\nLast model output:\n${lastWebLlmOutput}`
      : message;
    setStatus("Failed", "error");
  } finally {
    button.disabled = false;
  }
});
