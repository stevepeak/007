---
title: Tools
summary: Where tools come from, agent tools vs Tool nodes, argument validation, what a tool can read, large results, resume safety, and how tools behave in evals.
order: 55
---

A **tool** is a registered capability with a stable id. Every tool comes from one registry: the host's own tools, plus 007's built-ins (`extract_text` and document rendering), which `defineWfConfig` registers by default unless the host registers its own under the same id. Read `get_tool_catalog` for the list, and `get_tool_catalog({ toolIds })` for full input/output schemas.

## Where tools come from (`origin`)

- `host` — written by this deployment. The default.
- `sdk` — shipped by 007 itself (for example text extraction, document rendering); fixed until the package is upgraded.
- `connector` — proxied from a remote MCP server the host connected. Id shape `mcp:<connectorId>:<toolName>`, which never collides with a host id. Its read/write classification comes from the remote tool's `readOnlyHint` annotation (absent = write). Changes on the remote side need a connector refresh (`refresh_connector`, `list_connectors`).

Each tool also declares (visible in the catalog): `sideEffect` (`read`/`write`/untagged — drives eval behaviour), `requiresContext` (ambient run scope the host supplies, never an argument; an empty scope usually means "matches nothing", not an error), and an optional `statusLabel` (the user-facing line shown when an agent calls it — see [[streaming]]).

## Two ways to call a tool

| | Agent tool (`toolIds` on an agent) | Tool node ([[nodes/tool]]) |
| - | - | - |
| who decides the arguments | the model | the graph: each arg is a literal or a `ref` |
| which registry entries | `ai-tool` entries only | both `function` and `ai-tool` entries |
| validation | the model's call is checked against the input schema | bound args are parsed through the input schema (defaults applied); a mismatch fails the node |
| result goes to | the model's next turn; recorded in the step trace | the node's output, readable by downstream refs |

Tool-node args are written against the tool's schema field names. `validate_workflow_graph` and the editor's Issues panel flag args that no longer match the schema; ref **paths** into upstream outputs are not checked.

## What a tool can read

A tool sees only its arguments and the host's per-run dependencies. It cannot inspect the run. In particular:

- A Tool node can read **node outputs** through `ref` bindings, nothing else.
- An agent node's output is its answer (`{ text }` or its object). The tool calls it made, and their results, are only in the step trace — **no downstream node or tool can reference them**.
- To let later logic see what an agent retrieved, either have the agent return it in a structured output (`output.kind: "object"`), or call the retrieval as Tool nodes and feed their outputs to both the agent (via `${vars}`) and the later step.
- For checking that an agent's citations were actually seen in this run, 007 has a built-in mechanism: an agent's `referenceKinds` validates every inline reference against its prompt, messages and every tool result (including sub-agents') and strips unsourced ones. See [[agents]].

## Large values

A tool (or any node) may return a **blob ref** — a pointer to stored bytes — instead of a large value. Downstream nodes rehydrate it to the real value inside their own step before interpolation or argument validation, provided the host configured a blob resolver. On the durable engine, oversized node outputs are spilled automatically at the step boundary. See [[limits]].

## Retries and resume

A node can be re-executed: durable-engine retries replay the node body, and the inline engine resumes an interrupted run (for example after a deploy) by re-running the node that was in flight. **Tools with side effects must be idempotent** — accept a caller-supplied key or check for an existing record — or a resume can duplicate the effect. See [[execution]].

## Tools in evals

Under eval simulation, per tool (keyed by tool id):

- `write` tools are **always** neutralized; they return `{ simulated: true }`. The call is still recorded for grading.
- `read` tools are `mocked` by default and return the sample's pinned output for that tool id (or `{}` if none is pinned). A sample can set a tool to `live` to hit real data.
- **Untagged tools run for real** even under simulation — the host must tag any tool with an external effect.
- One pinned output per tool id: every call to that tool returns it, from the primary agent and from sub-agents alike.
- A synthesis sample stages earlier tool results as a seeded assistant turn and pins nothing; the agent keeps its tools, and calling one returns `{}`. (Older samples saved with a `frozen` mode load this same way.)
- `run_agent_preview` is different again: all tools are simulated by the model writing plausible results.

## Running one tool directly

`run_tool({ toolId, args, context })` executes one catalog tool **for real**, outside any workflow — the console's tool playground. `args` are validated and defaulted by the tool's input schema; `context` fills its `requiresContext` keys. A tool tagged `write`, or untagged, is refused unless `allowWrite: true`. The call is not recorded as a run, so it does not appear in `list_tool_invocations`.

### Document search: `index_document` and `search_documents`

When the host wires them, these two built-ins search its documents with Workers AI embeddings stored in Cloudflare Vectorize.

- `index_document` is a Tool node (`write`): `{ documentId, title?, text }` → `{ documentId, chunks }`. It splits the text into ~1500-character paragraph chunks, embeds each one and stores it. Re-indexing the same `documentId` overwrites its chunks. A typical ingest graph is trigger → `extract_text` → `index_document`, with `text` bound to `extract_text`'s `text`.
- `search_documents` is an agent tool (`read`): `{ query, topK? }` → `{ matches: [{ documentId, title, chunk, text, score }] }`, closest first. Give it to an agent and tell the prompt to search before answering and name the document it used.
- Both tools are scoped by the run (the host maps run scope to a Vectorize namespace), so a playground or `run_tool` call with a different scope searches a different set of documents.
- Indexing is eventually consistent. Wait a few seconds after `index_document` before expecting `search_documents` to find the new text.
- In evals `index_document` is neutralized like every write tool. `search_documents` returns the pinned fixture unless the sample marks it `live`.

### Testing `extract_text` on a file of your own

`extract_text` reads its file from R2: `source` is an object key in the Worker's `UPLOADS` bucket (unless the host overrode the tool with its own bucket), not a path or URL. To try a local file, put it there first with Wrangler — the bytes go from disk to R2 without passing through the model — then call the tool with that key:

```sh
# --local: the dev bucket the local worker reads; --remote: the deployed bucket
wrangler r2 object put <bucket>/eval-uploads/sample.pdf --file ./sample.pdf --local
```

```json
run_tool({ "toolId": "extract_text", "args": { "source": "eval-uploads/sample.pdf", "filename": "sample.pdf", "mimeType": "application/pdf" } })
```

- Run Wrangler from the project whose config binds that bucket, with credentials for the account. The bucket name is in that config, not in the catalog.
- `filename` and `mimeType` choose the path: `.txt`/`.md` pass through, a PDF whose text layer looks empty (or `forceOcr: true`) is OCR'd, everything else goes through markdown conversion. Read `mode` and `meta` in the reply to see which ran; an OCR failure falls back to `mode: "markdown"` with the reason in `meta.notes`.
- A result larger than the spill threshold comes back as a pointer with a preview; `meta.spilled` says so.
- Use a dedicated prefix such as `eval-uploads/` and delete test objects afterwards (`wrangler r2 object delete`); nothing cleans them up.

See [[evals]].
