// What KIND of thing a `wf_agent` row is. Two, and deliberately disjoint.
//
//   • 'generation' — the traditional agent: a system prompt, a user turn, a
//     tool loop, and an answer in prose or a structured object. `AgentConfig`.
//   • 'decision'   — a question set judged by a DECISION provider, rolled up
//     into one verdict. `DecisionAgentConfig`.
//
// The two configs share not one field, so this is a discriminator rather than a
// mode: nothing reads a decision agent's `prompt` because it has none. That is
// also why the kind is IMMUTABLE after creation — there is no meaningful
// conversion between the two shapes, so "change the type" is "make a new agent".
//
// It lives in its own module, importing nothing, because both ends of the stack
// need it: `storage/schema-agents.ts` types the column with it (and drizzle-kit
// loads that file), and `engine/decision-agent-schema.ts` is the schema it
// discriminates. A shared constant in either of those would drag the other's
// dependencies somewhere they don't belong.

export const WF_AGENT_KINDS = ['generation', 'decision'] as const
export type WfAgentKind = (typeof WF_AGENT_KINDS)[number]

/** The kind a row with no stored value has — every agent written before ART-238. */
export const DEFAULT_AGENT_KIND: WfAgentKind = 'generation'

/** Narrow an untrusted string (a DB column, a wire field) to a known kind. */
export function toAgentKind(value: unknown): WfAgentKind {
  return (WF_AGENT_KINDS as readonly string[]).includes(value as string)
    ? (value as WfAgentKind)
    : DEFAULT_AGENT_KIND
}
