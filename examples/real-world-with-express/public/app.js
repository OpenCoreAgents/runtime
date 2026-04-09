function $(id) {
  return document.getElementById(id);
}

function randomSessionId() {
  return crypto.randomUUID();
}

function getSessionId() {
  let s = $("sessionId").value.trim();
  if (!s) {
    s = randomSessionId();
    $("sessionId").value = s;
  }
  return s;
}

function bearerAuth() {
  const key = $("apiKey").value.trim();
  if (!key) return {};
  return {
    Authorization: key.startsWith("Bearer ") ? key : `Bearer ${key}`,
  };
}

function headersJson() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...bearerAuth(),
  };
}

function headersAuthGet() {
  return {
    Accept: "application/json",
    ...bearerAuth(),
  };
}

function headersSse() {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...bearerAuth(),
  };
}

async function loadHealth() {
  const el = $("healthLine");
  try {
    const r = await fetch("/health");
    const j = await r.json();
    el.textContent = `/health: ok=${j.ok} expressLlm=${j.expressLlm} openai=${j.openaiConfigured} anthropic=${j.anthropicConfigured} apiKeyRequired=${j.apiKeyRequired}`;
  } catch (e) {
    el.textContent = `/health failed: ${e}`;
  }
}

$("newSession").addEventListener("click", () => {
  $("sessionId").value = randomSessionId();
});

$("sendChat").addEventListener("click", async () => {
  const msg = $("chatMsg").value.trim();
  if (!msg) return;
  $("chatOut").textContent = "…";
  $("sendChat").disabled = true;
  try {
    const r = await fetch("/v1/chat", {
      method: "POST",
      headers: headersJson(),
      body: JSON.stringify({ message: msg, sessionId: getSessionId() }),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    $("chatOut").textContent = JSON.stringify(body, null, 2);
  } catch (e) {
    $("chatOut").textContent = String(e);
  } finally {
    $("sendChat").disabled = false;
  }
});

/** Minimal SSE reader for POST + fetch (EventSource is GET-only). */
async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let dataLine = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (dataLine) {
        let data;
        try {
          data = JSON.parse(dataLine);
        } catch {
          data = dataLine;
        }
        onEvent(event, data);
      }
    }
  }
}

$("sendStream").addEventListener("click", async () => {
  const msg = $("chatMsg").value.trim();
  if (!msg) return;
  $("streamOut").textContent = "";
  $("sendStream").disabled = true;
  const lines = [];
  try {
    const r = await fetch("/v1/chat/stream", {
      method: "POST",
      headers: headersSse(),
      body: JSON.stringify({ message: msg, sessionId: getSessionId() }),
    });
    if (!r.ok) {
      $("streamOut").textContent = await r.text();
      return;
    }
    await readSseStream(r, (ev, data) => {
      lines.push(`[${ev}] ${JSON.stringify(data)}`);
      $("streamOut").textContent = lines.join("\n");
    });
  } catch (e) {
    $("streamOut").textContent = String(e);
  } finally {
    $("sendStream").disabled = false;
  }
});

let lastWaitRunId = null;

$("waitDemo").addEventListener("click", async () => {
  $("waitOut").textContent = "…";
  $("waitLine").textContent = "…";
  lastWaitRunId = null;
  $("resumeBtn").disabled = true;
  try {
    const r = await fetch("/v1/runs/wait-demo", {
      method: "POST",
      headers: headersJson(),
      body: JSON.stringify({ sessionId: getSessionId() }),
    });
    const raw = await r.text();
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      $("waitOut").textContent = raw;
      $("waitLine").textContent = `HTTP ${r.status}`;
      return;
    }
    $("waitOut").textContent = JSON.stringify(j, null, 2);
    if (r.status === 409 && j.runId) {
      lastWaitRunId = j.runId;
      $("waitLine").textContent =
        "Session already has a waiting run — use Resume or another session.";
      $("resumeBtn").disabled = false;
      return;
    }
    if (j.status === "waiting" && j.runId) {
      lastWaitRunId = j.runId;
      $("waitLine").textContent = `Waiting — runId ${j.runId}. Enter text and Resume.`;
      $("resumeBtn").disabled = false;
    } else {
      $("waitLine").textContent = "Run finished without wait (unexpected for scripted demo).";
    }
  } catch (e) {
    $("waitOut").textContent = String(e);
    $("waitLine").textContent = "Error.";
  }
});

$("resumeBtn").addEventListener("click", async () => {
  if (!lastWaitRunId) return;
  const text = $("resumeText").value;
  if (typeof text !== "string") return;
  $("waitOut").textContent = "…";
  $("resumeBtn").disabled = true;
  try {
    const r = await fetch(`/v1/runs/${encodeURIComponent(lastWaitRunId)}/resume`, {
      method: "POST",
      headers: headersJson(),
      body: JSON.stringify({ sessionId: getSessionId(), text }),
    });
    const raw = await r.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      $("waitOut").textContent = raw;
      $("waitLine").textContent = `HTTP ${r.status}`;
      return;
    }
    $("waitOut").textContent = JSON.stringify(body, null, 2);
    $("waitLine").textContent = "Resumed.";
    lastWaitRunId = null;
  } catch (e) {
    $("waitOut").textContent = String(e);
  } finally {
    $("resumeBtn").disabled = true;
  }
});

function renderSessionPanel(data) {
  const panel = $("sessionPanel");
  panel.textContent = "";
  panel.classList.remove("muted");

  const head = document.createElement("p");
  head.style.margin = "0 0 0.5rem";
  head.style.fontSize = "0.85rem";
  head.style.color = "#555";
  head.appendChild(document.createTextNode("sessionId "));
  const sidCode = document.createElement("code");
  sidCode.textContent = data.sessionId ?? "";
  head.appendChild(sidCode);
  const total = data.summary?.total ?? (data.runs?.length ?? 0);
  head.appendChild(document.createTextNode(` · ${total} run(s)`));
  panel.appendChild(head);

  const runs = data.runs || [];
  if (runs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.style.margin = "0";
    empty.textContent = "No persisted runs for this session yet.";
    panel.appendChild(empty);
    return;
  }

  for (const run of runs) {
    const card = document.createElement("article");
    card.className = "run-card";

    const title = document.createElement("h3");
    title.textContent = `${run.agentId} · ${run.status}`;
    card.appendChild(title);

    const line = (label, value) => {
      const row = document.createElement("div");
      row.className = "run-meta";
      const strong = document.createElement("strong");
      strong.textContent = `${label} `;
      row.appendChild(strong);
      if (label === "runId") {
        const code = document.createElement("code");
        code.textContent = value;
        row.appendChild(code);
      } else {
        row.appendChild(document.createTextNode(value ?? "—"));
      }
      card.appendChild(row);
    };

    line("runId", run.runId);
    if (run.userInput != null && run.userInput !== "") {
      line("userInput", run.userInput);
    }
    if (Array.isArray(run.resumeInputs) && run.resumeInputs.length > 0) {
      const row = document.createElement("div");
      row.className = "run-meta";
      const strong = document.createElement("strong");
      strong.textContent = "resume input(s) ";
      row.appendChild(strong);
      const ul = document.createElement("ul");
      ul.style.margin = "0.25rem 0 0 1rem";
      ul.style.padding = "0";
      for (const t of run.resumeInputs) {
        const li = document.createElement("li");
        li.textContent = t;
        ul.appendChild(li);
      }
      row.appendChild(ul);
      card.appendChild(row);
    }
    if (run.reply != null) {
      line("reply", run.reply);
    }
    if (run.iteration != null) {
      line("iteration", String(run.iteration));
    }
    if (run.waitReason) {
      line("waitReason", run.waitReason);
    }

    if (Array.isArray(run.history) && run.history.length > 0) {
      const sub = document.createElement("div");
      sub.style.fontSize = "0.8rem";
      sub.style.fontWeight = "600";
      sub.style.margin = "0.6rem 0 0.25rem";
      sub.textContent = "Intermediate steps (history)";
      card.appendChild(sub);

      for (const step of run.history) {
        const block = document.createElement("div");
        block.className = "hist-step";
        const typeEl = document.createElement("div");
        typeEl.className = "step-type";
        const c0 = step.content;
        const isResumeObs =
          step.type === "observation" &&
          c0 &&
          typeof c0 === "object" &&
          c0.kind === "resume_input";
        typeEl.textContent = isResumeObs ? "observation · resume input" : step.type;
        block.appendChild(typeEl);
        const pre = document.createElement("pre");
        const c = step.content;
        pre.textContent =
          typeof c === "string" ? c : JSON.stringify(c, null, 2);
        block.appendChild(pre);
        if (step.meta && typeof step.meta === "object") {
          const meta = document.createElement("div");
          meta.style.fontSize = "0.68rem";
          meta.style.color = "#666";
          meta.style.marginTop = "0.25rem";
          meta.textContent = `meta: ${JSON.stringify(step.meta)}`;
          block.appendChild(meta);
        }
        card.appendChild(block);
      }
    } else if (run.historyStepCount != null && run.historyStepCount > 0) {
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.style.fontSize = "0.78rem";
      hint.style.margin = "0.5rem 0 0";
      hint.textContent = `${run.historyStepCount} step(s) — untick “Thin response” and Refresh to load full history.`;
      card.appendChild(hint);
    }

    panel.appendChild(card);
  }
}

$("refreshSession").addEventListener("click", async () => {
  $("sessionPanel").textContent = "…";
  $("sessionPanel").classList.add("muted");
  $("sessionRaw").textContent = "…";
  try {
    const sid = getSessionId();
    const light = $("sessionLight").checked ? "?light=1" : "";
    const r = await fetch(
      `/v1/sessions/${encodeURIComponent(sid)}/status${light}`,
      { headers: headersAuthGet() },
    );
    const rawText = await r.text();
    let j;
    try {
      j = JSON.parse(rawText);
    } catch {
      $("sessionPanel").textContent = rawText;
      $("sessionRaw").textContent = rawText;
      return;
    }
    $("sessionRaw").textContent = JSON.stringify(j, null, 2);
    if (!r.ok) {
      $("sessionPanel").textContent = `HTTP ${r.status}: ${JSON.stringify(j)}`;
      $("sessionPanel").classList.add("muted");
      return;
    }
    renderSessionPanel(j);
  } catch (e) {
    $("sessionPanel").textContent = String(e);
    $("sessionPanel").classList.add("muted");
    $("sessionRaw").textContent = String(e);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem("expressDemoApiKey");
  if (saved) $("apiKey").value = saved;
  $("sessionId").value = randomSessionId();
  loadHealth();
});

$("apiKey").addEventListener("change", () => {
  sessionStorage.setItem("expressDemoApiKey", $("apiKey").value.trim());
});
