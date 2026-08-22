import { Goal, Microscope, Play } from 'lucide-react'
import { useState } from 'react'

import type { EvalSampleLayer } from '../../server/protocol'
import { ArchiveButton } from '../archive-button'
import { useWfComponents } from '../context'
import { useWfNav } from '../nav'
import { QueryState } from '../query-state'
import { WfShell } from '../shell'
import { sectionCrumb } from '../wf-crumbs'

import { RunsForSample } from './eval-sample-checks'
import { SampleConfigSteps } from './eval-sample-steps'
import { RunConfigDialog } from './run-config-dialog'
import { EmptyState, Tabs, useTargetAgentCrumb } from './shared'
import { useEvalSampleDraft } from './use-eval-sample-draft'

// The Sample view (route: evals/<setId>/samples/<sampleId>). A Sample IS a
// wf_eval_row, and it answers three questions in order:
//
//   1. INPUT  — what is the target invoked with? The editor is chosen by the
//               TARGET's own contract (task variables / a conversation thread /
//               a workflow's trigger payload), so there is exactly one input
//               source per sample instead of several competing ones.
//   2. TOOLS  — how do its tools behave? One tri-state: mocked, none, or live.
//   3. CHECKS — what has to be true of the run? Each check is a collapsible row
//               authored in place (there is no separate Check page), and gated
//               by the tools setting, so a trajectory check can't be authored
//               where no tool step will exist.
//
// Those three are `SampleConfigSteps`; what they're allowed to say is decided in
// `useEvalSampleDraft`. This file is the page around them.
//
// Which TESTING LAYER that adds up to (synthesis, trajectory, integration) is
// derived and shown in the header — never stored, so it can't drift from the
// settings it names. Edits persist to the row on blur / on action (rows are
// mutable; no version step).

type SampleTab = 'config' | 'runs'

export type EvalSampleProps = {
  setId: string
  sampleId: string
  /**
   * Open with this check already expanded — how a run report's per-check link
   * (`?check=<i>`) hands an investigation over, instead of dropping you on the
   * sample and making you find the check in it again.
   */
  initialCheckIndex?: number | null
  className?: string
}

// The header badge for the derived testing layer. `io` gets no badge — a plain
// input → output test is the baseline, not a mode worth naming.
const LAYERS: Record<
  Exclude<EvalSampleLayer, 'io'>,
  { label: string; className: string; title: string }
> = {
  synthesis: {
    label: 'Synthesis',
    className: 'bg-amber-100 text-amber-700',
    title:
      'A staged conversation with no tools — grades the final response in isolation.',
  },
  trajectory: {
    label: 'Trajectory',
    className: 'bg-violet-100 text-violet-700',
    title:
      'Mocked tools — grades which tools the agent reached for, and with what.',
  },
  integration: {
    label: 'Integration',
    className: 'bg-sky-100 text-sky-700',
    title: 'Live read tools — grades the agent against real retrieval.',
  },
}

export function EvalSample({
  setId,
  sampleId,
  initialCheckIndex,
  className,
}: EvalSampleProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const [tab, setTab] = useState<SampleTab>('config')
  const [runOpen, setRunOpen] = useState(false)
  // Whether the "add mock" tool picker is open — lifted here so its trigger can
  // live in the Tools step's header (far right) while the picker renders in the
  // step body.
  const [addMockOpen, setAddMockOpen] = useState(false)

  const state = useEvalSampleDraft({ setId, sampleId, initialCheckIndex })
  const { set, row, draft } = state
  const targetAgentCrumb = useTargetAgentCrumb(set?.targetId, set?.targetVersion)
  const badge = state.layer === 'io' ? null : LAYERS[state.layer]

  return (
    <WfShell
      className={className}
      scroll
      titleIcon={<Microscope className="size-5 shrink-0 text-rose-500" />}
      assetLabel="Sample"
      crumbs={[
        sectionCrumb('evals'),
        {
          assetLabel: 'Goal',
          label: set?.name ?? 'Goal',
          to: `evals/${setId}`,
          icon: Goal,
          iconClassName: 'text-rose-500',
        },
        ...(targetAgentCrumb ? [targetAgentCrumb] : []),
        row && draft
          ? {
              editable: {
                value: draft.name,
                onChange: (name) => state.setDraft({ ...draft, name }),
                onCommit: () => {
                  if (draft.name !== row.name) state.persist(draft)
                },
                ariaLabel: 'Sample name',
              },
            }
          : { label: 'Sample' },
      ]}
      descriptionEditable={
        row && draft
          ? {
              value: draft.description,
              onChange: (description) => state.setDraft({ ...draft, description }),
              onCommit: () => {
                if (draft.description !== (row.description ?? '')) {
                  state.persist(draft)
                }
              },
              ariaLabel: 'Sample description',
            }
          : undefined
      }
      actions={
        row && draft ? (
          <>
            {badge ? (
              <span
                title={badge.title}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${badge.className}`}
              >
                {badge.label}
              </span>
            ) : null}
            <ArchiveButton
              description={
                <>
                  Archive <strong>{draft.name || 'this sample'}</strong>? It’ll
                  be removed from the goal, along with its checks.
                </>
              }
              onConfirm={() => {
                state.deleteRow.mutate(row.id)
                navigate(`evals/${setId}`)
              }}
            />
            <Button size="sm" variant="outline" onClick={() => setRunOpen(true)}>
              <Play className="size-4" />
              Run Sample
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <QueryState
          // `draft` is local state seeded from `row`, so the sample is only
          // really ready when both have landed — one gate, not two.
          query={{
            isLoading: state.isLoading,
            error: null,
            data: row && draft ? { row, draft } : undefined,
          }}
          loading={<EmptyState message="Loading sample…" />}
          empty={
            <EmptyState message="This sample doesn't exist, or was archived / removed." />
          }
        >
          {({ draft }) => (
            <>
              <RunConfigDialog
                open={runOpen}
                onClose={() => setRunOpen(false)}
                scope="sample"
                targetName={set?.name || draft.name || 'goal'}
                setIds={[setId]}
              />

              <Tabs
                active={tab}
                onChange={(k) => setTab(k as SampleTab)}
                tabs={[
                  { key: 'config', label: 'Configuration' },
                  { key: 'runs', label: 'Test runs' },
                ]}
              />

              {tab === 'config' ? (
                <SampleConfigSteps
                  state={state}
                  draft={draft}
                  addMockOpen={addMockOpen}
                  onAddMockOpenChange={setAddMockOpen}
                />
              ) : (
                <RunsForSample setId={setId} />
              )}
            </>
          )}
        </QueryState>
      </div>
    </WfShell>
  )
}
