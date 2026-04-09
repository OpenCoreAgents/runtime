# Utils: internal utilities

Pure functions and helpers used by **tools** and **adapters** internally. Utils never appear in the LLM prompt, never receive `ToolContext`, and never produce side effects on their own. They are the implementation layer beneath tools.

Related: [05-adapters.md](./05-adapters.md) (adapter contracts), [17-rag-pipeline.md](./17-rag-pipeline.md) (RAG tools that consume these utils).

---

## 1. Design rule

| Principle | Detail |
|-----------|--------|
| **No side effects** | Utils read input and return output. I/O goes through adapters. |
| **No `ToolContext`** | If the function needs `projectId`, `sessionId`, or `memoryAdapter`, it belongs in a tool or adapter — not in utils. |
| **Invisible to the LLM** | The model never sees util names, signatures, or options. Tools expose a high-level schema; utils are the internals. |
| **Testable in isolation** | Pure input → output. No mocks for Redis, Vector, or LLM needed. |

---

## 2. Planned utils

### 2.1 `parsers/` — file content extraction

Converts raw file buffers into plain text with metadata.

```typescript
interface ParseResult {
  text: string;
  metadata: {
    mimeType: string;
    pages?: number;
    encoding?: string;
    title?: string;
  };
}

function parseFile(buffer: Buffer, mimeType: string): Promise<ParseResult>;
```

| Format | Library (reference) | Notes |
|--------|---------------------|-------|
| `.txt`, `.md` | built-in | UTF-8 decode; preserve structure for markdown. |
| `.pdf` | `pdf-parse` or equivalent | Extract text per page; populate `pages`. |
| `.docx` | `mammoth` or equivalent | HTML → plain text conversion. |
| `.csv` | `csv-parse` | Row-based text; optional header detection. |
| `.html` | `htmlparser2` + `dom-serializer` | Strip tags, keep structure. |
| `.json` | built-in | `JSON.stringify` with readable formatting. |

`parseFile` detects format from `mimeType` and delegates to the matching parser. Unknown types return a clear error — they do not silently produce empty text.

### 2.2 `chunking/` — text splitting strategies

Splits a text string into bounded fragments suitable for embedding and retrieval.

```typescript
interface ChunkOptions {
  method: "fixed_size" | "sentence" | "paragraph" | "recursive";
  maxTokens: number;
  overlap: number;
}

interface Chunk {
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
}

function chunkText(text: string, options: ChunkOptions): Chunk[];
```

| Method | Behavior |
|--------|----------|
| `fixed_size` | Split every `maxTokens` tokens with `overlap` token overlap. Simplest; may cut mid-sentence. |
| `sentence` | Split on sentence boundaries, merging sentences until `maxTokens` is reached. |
| `paragraph` | Split on double newlines; merge short paragraphs, split long ones recursively. |
| `recursive` | Try paragraph → sentence → fixed-size as fallback hierarchy. Preferred default. |

**Token counting**: use a fast tokenizer (e.g. `tiktoken` for OpenAI models) or a byte-pair approximation. The `tokenCount` in each `Chunk` reflects the actual count, not a character estimate.

**Overlap**: when `overlap > 0`, the last `overlap` tokens of chunk N are prepended to chunk N+1 to preserve context across boundaries.

### 2.3 `file-resolver/` — source resolution

Resolves a source string (local path, URL, or storage reference) into a readable buffer and mime type.

```typescript
interface ResolvedFile {
  buffer: Buffer;
  mimeType: string;
  size: number;
  name: string;
}

function resolveSource(source: string): Promise<ResolvedFile>;
```

| Source pattern | Resolution |
|----------------|------------|
| `/absolute/path` or `./relative` | Read from local filesystem. |
| `https://…` or `http://…` | HTTP GET; detect mime from `Content-Type` header. |
| `s3://bucket/key` | AWS S3 `GetObject` (requires configured credentials). |
| `gs://bucket/path` | GCS equivalent. |

**Security note**: `resolveSource` itself does not enforce access control. The calling **tool** must verify that the source is allowed for the current `projectId` and `SecurityContext` before invoking this util. See [08-scope-and-security.md](./08-scope-and-security.md).

---

## 3. Placement in the source tree

```
src/
  utils/
    parsers/
      index.ts          → parseFile (dispatcher)
      pdf.ts
      docx.ts
      csv.ts
      html.ts
    chunking/
      index.ts          → chunkText (dispatcher)
      strategies/
        fixed-size.ts
        sentence.ts
        paragraph.ts
        recursive.ts
    file-resolver/
      index.ts          → resolveSource (dispatcher)
      local.ts
      http.ts
      s3.ts
```

Each subdirectory exports a single entry function. Strategy-specific logic lives in internal modules and is not re-exported.

---

## 4. Relationship to tools and adapters

```
LLM
 │  action: system_file_ingest({ source: "policy.pdf" })
 ▼
ToolRunner → system_file_ingest tool
               │
               ├── resolveSource("policy.pdf")        ← util (file-resolver)
               ├── parseFile(buffer, "application/pdf") ← util (parsers)
               ├── chunkText(text, { method, … })      ← util (chunking)
               ├── embeddingAdapter.embedBatch(texts[]) ← adapter
               └── vectorAdapter.upsert(scope, docs[])  ← adapter
               │
               ▼
             observation: { chunksCreated: 47 }
```

Utils handle the **deterministic transformation** steps (parse, chunk). Adapters handle **I/O** (embed, store). The tool orchestrates both and returns a result the engine can serialize as an observation.

---

## 5. Future utils

| Candidate | Purpose | When |
|-----------|---------|------|
| `token-counter/` | Accurate token counting for context budget in Context Builder ([11-context-builder.md](./11-context-builder.md)). | MVP or MVP+ |
| `sanitizer/` | Strip PII, secrets, or disallowed content before embedding or storing in memory. | When security policy requires it. |
| `summary/` | Deterministic summarization heuristics (truncate, extract headings) for context overflow — distinct from LLM-based summarization. | v2 |
