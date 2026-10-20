import { z } from 'zod'

import { sha256Hex } from '../engine/sha256'
import { stableStringify } from '../engine/stable-stringify'

import {
  agentIdArg,
  notFound,
  optString,
  reqString,
  type WfMcpTool,
} from './tools'
import {
  changedKeys,
  preflightAgentConfig,
  preflightDecisionAgentConfig,
} from './tools-agents'

// `publish_agent` — the step ART-234 kept out, now in, behind the three gates
// that decision named as the price of shipping it.
//
// Why it was out: an agent version floats into every workflow that references
// it without a pin, so one publish changes what an unknown number of live
// workflows do, at once — and nothing in the arguments says how many. A
// workflow publish changes one trigger's behaviour; an agent publish can change
// ten.
//
// The gates, each answering one part of that:
//
//   1. **A dry run is mandatory.** Called without `confirm`, the tool publishes
//      nothing and reports the blast radius: every workflow whose PUBLISHED
//      graph references the agent, split into the ones that float (they change
//      on their next run) and the ones that pin a version (they don't).
//   2. **The confirmation is bound to what was shown.** The dry run returns a
//      token derived from the agent, the live version and the exact draft
//      config. Publishing requires echoing it back, so the publish cannot be the
//      first call a session makes, and an edit to the draft — by anyone — after
//      the dry run invalidates the token rather than shipping something nobody
//      looked at. Stateless on purpose: the MCP is served per request, so there
//      is nowhere to keep a pending confirmation, and nothing needs to be.
//   3. **`baseVersionNumber`**, exactly as `publish_workflow` takes it, so a
//      version someone else published since the caller read the agent is never
//      silently superseded.
//
// The draft is also preflighted the way `update_agent_draft` checks it, because
// a draft can be written by the console with a model that has since been
// disabled — and the publish is the last point at which that is cheap to catch.

/**
 * The confirmation token: a short digest of what the dry run showed.
 *
 * Not a secret and not a signature — a model could compute it, and that is
 * fine. Its job is to make "publish" a second call that names the draft the
 * first call reviewed, so a changed draft or a newer live version reads as a
 * mismatch instead of shipping.
 */
async function confirmToken(
  agentId: string,
  base: number,
  config: unknown,
): Promise<string> {
  return await sha256Hex({
    text: stableStringify({ agentId, base, config }),
    bytes: 6,
  })
}

export function agentPublishTools(): WfMcpTool[] {
  return [
    {
      name: 'publish_agent',
      title: 'Publish agent',
      description: [
        'Publish an agent’s current DRAFT as its next immutable version. THIS CHANGES WHAT CUSTOMERS GET, possibly in several workflows at once: every workflow node that points at the agent without a version pin runs the new version from its next run.',
        '',
        'Two calls, always:',
        '  1. Without `confirm` — a dry run. Nothing is published. The reply lists what changed against the live version, every workflow that will pick it up (`affected.floating`), those pinned to an older version that will not (`affected.pinned`), and a `confirm` token. Show the user that list before going on.',
        '  2. With `confirm` set to that token, plus `changeNote` — publishes. The token is bound to the exact draft and live version the dry run saw, so if anyone edits the draft or publishes in between it is refused and you dry-run again.',
        '',
        '`baseVersionNumber` is the live versionNumber you read (get_agent → currentVersion.versionNumber), as for publish_workflow. The draft is re-checked like update_agent_draft checks it — model id and capabilities, tool ids, a decision agent’s rules — so a draft that would fail at run time is refused here. Grade it first with run_eval({ draftAgentId }). The version records you (the authorized user) as its publisher; name a reviewer or approver in `changeNote` if one signed off.',
      ].join('\n'),
      inputSchema: {
        agentId: agentIdArg,
        baseVersionNumber: z
          .number()
          .describe(
            'The currently published versionNumber you based the draft on (0 if never published). Refused if a newer one exists.',
          ),
        changeNote: z
          .string()
          .nullish()
          .describe(
            'What changed and why, in one line — a git commit subject. Required when publishing; optional on the dry run.',
          ),
        confirm: z
          .string()
          .nullish()
          .describe(
            'The `confirm` token from this tool’s dry run. Omit to dry-run.',
          ),
        summarize: z
          .boolean()
          .nullish()
          .describe(
            'Generate the version’s AI change summary as part of publishing (default true; generation agents only). Pass false to skip the extra model call.',
          ),
      },
      readOnly: false,
      run: async (client, args) => {
        const agentId = reqString(args.agentId, 'agentId')
        const base = args.baseVersionNumber
        if (typeof base !== 'number' || !Number.isSafeInteger(base)) {
          return {
            error:
              'Missing required argument `baseVersionNumber` — the live versionNumber from get_agent (0 if never published).',
          }
        }

        const detail = await client.getAgent(agentId)
        if (!detail) return notFound({ kind: 'agent', id: agentId })
        const live = detail.currentVersion
        const liveNumber = live?.versionNumber ?? 0
        if (liveNumber !== base) {
          return {
            error: `Refused: v${liveNumber} is live but you based this on v${base}. Someone published since you read the agent. Re-read it (get_agent), check your draft still makes sense on top of v${liveNumber}, and pass baseVersionNumber: ${liveNumber}.`,
          }
        }
        if (!detail.draft) {
          return {
            error: `Refused: there is no draft to publish — v${liveNumber} is already what runs. Write one with update_agent_draft first.`,
          }
        }
        const changed = changedKeys(live?.config, detail.draft.config)
        if (live && changed.length === 0) {
          return {
            error: `Refused: the draft is identical to v${liveNumber}; publishing would create an empty version.`,
          }
        }

        const kind = detail.agent.kind
        const checked =
          kind === 'decision'
            ? await preflightDecisionAgentConfig(client, detail.draft.config)
            : await preflightAgentConfig(client, detail.draft.config)
        if ('error' in checked) {
          return {
            error: `Refused: the draft would not run. ${checked.error}\nFix it with update_agent_draft, then dry-run again.`,
          }
        }

        const token = await confirmToken(agentId, base, detail.draft.config)
        const confirm = optString(args.confirm)

        if (!confirm) {
          const affected = await client.getAgentBlastRadius(agentId)
          return {
            dryRun: true,
            agentId,
            name: detail.agent.name,
            kind,
            live: live ? `v${liveNumber}` : null,
            wouldPublish: `v${liveNumber + 1}`,
            changed,
            affected,
            confirm: token,
            note:
              affected.floating.length === 0
                ? 'No published workflow floats on this agent, so publishing changes no live run yet. To publish, call again with this `confirm` token and a `changeNote`.'
                : `${affected.floating.length} published workflow${affected.floating.length === 1 ? '' : 's'} will run the new version from the next run (affected.floating). Show the user that list. To publish, call again with this \`confirm\` token and a \`changeNote\`. Other agents that delegate to this one through subAgents also pick it up unless their target pins a version.`,
          }
        }

        if (confirm !== token) {
          return {
            error:
              'Refused: the `confirm` token does not match this draft. The draft or the live version changed since the dry run (or the token was mistyped). Dry-run again — call without `confirm` — and review what it reports.',
          }
        }
        const changeNote = optString(args.changeNote)?.trim()
        if (!changeNote) {
          return { error: 'Missing required argument `changeNote` — what changed and why, in one line.' }
        }

        // Inline, before the publish, for the same reason publish_workflow does
        // it: a host with no background task would otherwise leave the version
        // with a null summary forever. Generation agents only — the handler
        // does not summarize a decision agent's rules table either.
        const aiSummary =
          kind === 'generation' && args.summarize !== false
            ? await client
                .summarizeAgentChanges({ agentId, config: detail.draft.config })
                .catch(() => undefined)
            : undefined

        const out = await client.publishAgent({
          agentId,
          config: detail.draft.config,
          changeNote,
          aiSummary,
          baseVersionNumber: base,
        })
        return {
          ok: true,
          agentId,
          published: { versionId: out.versionId, versionNumber: out.versionNumber },
          previous: live ? liveNumber : null,
          changed,
          summary: aiSummary?.short,
          note: `v${out.versionNumber} is live: every workflow node pointing at ${detail.agent.name} without a version pin runs it from its next run. Runs already in flight finish on the version they started with. To roll back: update_agent_draft({ fromVersion: ${liveNumber} }) and publish again.`,
        }
      },
    },
  ]
}
