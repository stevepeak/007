# Working on this package

`README.md` and `guide.md` are both about **integrating** the SDK into a host.
This file is for **changing the SDK itself** — where things live, what the
compiler will and won't catch you on, and the two or three facts about this
codebase that are non-obvious enough to cost you an hour.

Roughly 470 files / 86k lines. You will not read them. You shouldn't have to.

---

## 1. The layering rule

```
ui → server → storage → engine
cloudflare  → storage → engine
```

One direction. No cycles. In particular:

> **`engine` imports only `ai` and `zod`.** That is what makes this package
> publishable, and it is not a style preference.

This is **enforced by ESLint**, not just documented — `no-restricted-imports`
rules in `eslint.config.js` fail the build on a cross-layer import. If you find
yourself wanting engine to reach sideways, the answer is almost always to move
the shared value *down* into engine, or to put the test in the higher layer.

There is one deliberate exception, and it is a test: `src/cloudflare/engine-contract.test.ts`
holds the two cases that assert engine↔cloudflare boundary behaviour. They live
in `cloudflare/` — the higher layer — precisely so `engine/` stays clean.

---

## 2. To add a node kind

Node kinds used to be spread across a dozen hand-maintained tables. They are
now derived from one registry, so the compiler walks you through it.

**Start here, and let the errors lead:**

| # | file | what you add |
| - | ---- | ------------ |
| 1 | `src/engine/graph-kinds.ts` | one entry in `NODE_KIND_REGISTRY` — label, icon *name*, timeout class, `bookend`, `decision`, palette copy |
| 2 | `src/engine/graph-schema.ts` | a `baseNode.extend({ kind: z.literal('…'), config: … })`, added to the `workflowNodeSchema` union |
| 3 | `src/engine/node-kind-seeds.ts` | what a freshly-dragged node contains, or `null` for a template-owned bookend |
| 4 | `src/engine/run-node.ts` | a `case` in the executor switch (skip only if the kind never executes) |
| 5 | `src/engine/nodes/<kind>.ts` | the executor itself |
| 6 | `src/ui/editor/node-renderers.tsx` | an entry in `NODE_TYPES` |
| 7 | `src/ui/editor/node-io.ts` | `nodeRequires` + `nodeOutput` — what the node consumes and advertises |

**Step 1 alone is a compile error until step 3 is done**, and step 3 is a compile
error until step 2 is — `NODE_KIND_SEEDS` is typed `Record<WfNodeKind, …>` with
each seed `Extract`ed to its own kind, so a missing entry and a wrong config
shape both fail at the same place. Steps 4 and 7 are guarded by `satisfies never`
in their `default:` branches.

Steps 5 and 6 are the two the compiler *cannot* force — a missing renderer falls
back to xyflow's default box rather than failing. Don't skip them.

Two things that are deliberately **not** in the registry:

- **Default config** lives in `node-kind-seeds.ts`, one module up, because
  seeding an iteration needs `buildIterationSubgraph` and importing it into
  `graph-kinds.ts` would close the cycle
  `graph-kinds → graph-builders → graph-schema → graph-kinds`.
- **Icons are names, not components.** `graph-kinds.ts` stores `'Sparkles'`;
  `src/ui/editor/node-kind-icons.ts` is the single place that resolves a name to
  a `lucide-react` component. The engine must never import `lucide-react` — see
  the layering rule.

**A gotcha in step 2:** `iterationSubgraphSchema` is declared
`const iterationSubgraphSchema: z.ZodType<WorkflowGraph> = z.lazy(…)`. The
explicit annotation is load-bearing at the type level — without it TypeScript
collapses the recursive schema (and everything reading it) to `any`. If your new
union member makes it complain, fix the member; do not loosen the annotation.

---

## 3. To add an RPC method

One POST route carries every call. The contract is `WfDataClient`.

| # | file | what you add |
| - | ---- | ------------ |
| 1 | `src/server/protocol-<area>.ts` | the DTO types |
| 2 | `src/server/protocol-client.ts` | the method on the `WfDataClient` interface |
| 3 | `src/server/handlers.ts` | an entry in `wfInputSchemas` |
| 4 | `src/server/handlers/<area>.ts` | the handler |
| 5 | `src/storage/data*.ts` | the query |
| 6 | `src/server/http-client.ts` | a `bind('yourMethod')` line |
| 7 | `src/ui/hooks-<area>.ts` | the react-query hook |

Step 3 is not optional and not skippable: `wfInputSchemas` is
`Record<keyof WfDataClient, z.ZodType>` — **total**, not partial — so step 2
fails to compile until step 3 declares how the input is checked. Step 4 is
likewise forced, because `WfHandlers` is a mapped type over `WfDataClient`.

**Two properties of step 3 that have bitten before:**

- The schema describes the **wire** shape, not the TypeScript signature. Methods
  taking a positional id (`getWorkflow(workflowId)`) are wrapped into
  `{ workflowId }` by `createHttpWfDataClient`, so that object is what you
  declare.
- **`z.object` strips unknown keys**, and the dispatcher forwards `parsed.data`
  to the handler. A field your schema doesn't name is not merely unvalidated —
  it is **deleted before the handler sees it**. This is why rich payloads
  (`graph`, `config`, eval `checks`) are declared as `z.unknown()` and validated
  downstream in `parseGraph` / `parseAgentConfig`. Two sentinels exist to make
  the intent explicit rather than accidental: `NO_INPUT` and `PASSED_THROUGH`.

In step 6, `bind()` covers zero-arg and single-object methods. A method taking a
**positional** argument needs an explicit arrow — `getWorkflow: (workflowId) =>
call('getWorkflow', { workflowId })`.

---

## 4. The three tsconfigs

`bun run typecheck` runs all three. They exist because **the DOM lib and
`@cloudflare/workers-types` declare conflicting globals** — `fetch`, `Response`,
`WebSocket`. A single project spanning both makes Workers code fail against DOM
signatures.

| project | covers | libs |
| ------- | ------ | ---- |
| `tsconfig.json` | everything except `src/ui` and tests | Workers types |
| `tsconfig.ui.json` | `src/ui` **and its tests** | DOM + JSX |
| `tsconfig.test.json` | tests outside `src/ui` | Workers types, `noUnusedLocals` off |

Note the asymmetry: UI tests are typechecked by `tsconfig.ui.json`, not by
`tsconfig.test.json`, because they need the DOM lib the UI project already has.

ESLint needs the same split. `eslint.config.js` sets `projectService: false` plus
an explicit `project` for the `src/ui/**` and `src/**/*.test.ts` globs — without
it the parser resolves those files against `tsconfig.json`, which excludes them,
and every one fails with "was not found by the project service." That is how 37k
lines of UI once sat unlinted.

**`bun test` strips types, it does not check them.** Passing tests tell you
nothing about whether their fixtures still match the types they claim to model.
Run `bun run typecheck`.

---

## 5. Writing tests

Use the helpers. There are two, and they exist because the alternative is a
hand-rolled node literal that silently drifts from the schema.

- **`src/engine/executor-test-helpers.ts`** — a mock `toolRegistry`, `makeConfig`,
  and `chainGraph`. Eleven test files use it; this is the pattern to copy.
- **`src/engine/graph-builders.ts`** — `buildStarterGraph`, `buildIterationSubgraph`.
  Production code, reusable from tests, and always schema-valid.

**41 test files still hand-roll node literals.** That is not an invitation to add
a forty-second. If a helper doesn't cover your case, extend the helper.

---

## 6. UI conventions

**The loading ladder.** Don't hand-roll `isLoading` → `error` → `empty` →
content. `src/ui/query-state.tsx` sequences it, and `loading` / `error` default
to the house markup so a conversion is usually three lines. The handful of places
that legitimately can't use it each say why in a comment — find them with
`grep -rn "Not a QueryState ladder" src/ui` and read one before deciding yours
belongs with them. The recurring reasons are a surface whose states are
scattered across separate chrome slots (so no wrapper owns a region to
sequence), and two queries folded into one flag for a picker.

**Reading the clock.** `Date.now()` during render is impure and the React
Compiler rejects it: the value moves every render, so anything derived from it
(a query window, an age bucket) is different each pass and a `useMemo` over it
can never settle. `src/ui/use-now.ts` has the two honest answers —
`usePickedAt` (a value plus the instant it was picked, captured in the event
handler) and `useTickingNow` (a live clock that stops when you pass `null`).

**React Compiler diagnostics are ON.** `purity`, `immutability`,
`preserve-manual-memoization`, and `set-state-in-effect` all fail the build.
Eleven `set-state-in-effect` sites carry a per-line `eslint-disable-next-line`
with the reason inline; those are React-sanctioned patterns (reset on identity
change, re-sync to a refetched value, layout measurement, reconciling browser
history). If you need a twelfth, write the reason.

**Host-injected primitives.** Design-system components come out of context
(`const { Button } = useWfComponents()`) and icons out of module-level
registries. `@eslint-react/static-components` is off for `src/ui` because it
cannot see through the context boundary — the provider memoises the components
object, so identities are stable. This is the one place the SDK deliberately
overrides a React rule; the real hazard it gestures at lives in the *host*
(passing an inline object as `components` defeats the memo).

**Component size.** Split by **lifecycle or concern**, not by screen region.
The shape a surface converges on is a `use<Thing>` hook holding what is true, a
component holding what it looks like, and — where there is real arithmetic — a
plain module holding what it computes.

`src/ui/editor/use-agent-editor-state.ts` is the worked example for the first:
an agent's metadata is unversioned and saves on blur while its config is drafted
and published, so they are two hooks rather than one pile of `useState`.
`src/ui/editor/use-workflow-editor-state.ts` is the same split for a workflow
(description vs graph).

The third piece is the one worth reaching for. `run-activity-tree` was one
function doing three unrelated jobs, so it is now four modules — model, index,
rows, state-rows — and its nineteen tests passed untouched through the split,
which is the signal you want. `evals/run-report/matrix-model.ts` came out of
JSX and got its own tests, because deciding which model wins on cost is
arithmetic, not markup. `run-selection.ts` likewise: resolving which recorded
step belongs to the selected node is fiddly enough to be worth testing away from
the page that renders it.

**Deliberate exceptions carry a comment.** `AgentConfigPanel` runs past ~200
lines on purpose and says so at the top: what is left after its derivations
moved into `useAgentConfigFacts` is a flat sequence of seven `<EditorSection>`
blocks with no nesting or shared state, where the file order IS the screen
order. If you leave something long, say why there — a bare long function reads
as an oversight.

---

## 7. Before you commit

```sh
bun run typecheck   # all three projects
bun run lint        # must be 0 errors AND 0 warnings
bun test
```

`bun run fix` auto-fixes what it can (import order is the common one).

The repo is at zero lint problems. Keep it there — a warning baseline is how
37k unlinted lines happened the first time.
