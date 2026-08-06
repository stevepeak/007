import { useMemo } from 'react'

import { useProviderBudgets, useProviders } from '../hooks'
import { WfLink } from '../nav'
import { ProviderBudgetCard } from '../provider-budget'

import { ChartCard } from './chart-parts'

// How much money is left with each model provider — the one number on this page
// that isn't about the past. A run only fails on an exhausted budget once you've
// already spent it, so this sits next to the cost chart rather than buried in
// the Models admin page.

export function ProvidersPanel({ className }: { className?: string }) {
  const providers = useProviders()
  const budgets = useProviderBudgets()

  const budgetById = useMemo(
    () => new Map((budgets.data ?? []).map((b) => [b.providerId, b])),
    [budgets.data],
  )

  // Nothing to show before the provider list arrives, nothing worth a card if
  // the host wired none up, and nothing useful to say if the balances failed to
  // load — all three stay silent. This panel is a nicety on the home page, so it
  // drops out rather than filling the grid with "unavailable"; the Models page
  // is where an admin gets told WHY a balance is missing.
  const list = providers.data ?? []
  if (providers.error || budgets.error || list.length === 0) return null

  // Once budgets have LANDED and no provider reports one (a host wiring only
  // direct Anthropic/OpenAI keys, neither of which publishes a balance API),
  // the panel would be a row of "doesn't report" — drop it instead. While the
  // request is still in flight we keep rendering, so the cards can skeleton.
  const anyReports =
    budgets.data == null || budgets.data.some((b) => b.status !== 'unsupported')
  if (!anyReports) return null

  return (
    <ChartCard
      title="Providers"
      subtitle="Credit remaining on each model provider key"
      action={
        <WfLink
          to="models"
          className="text-xs text-neutral-500 underline-offset-2 hover:underline"
        >
          Models
        </WfLink>
      }
      footnote="Read live from each provider on load — never cached. Providers that publish no balance API report nothing."
      className={className}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {list.map((provider) => (
          <ProviderBudgetCard
            key={provider.id}
            label={provider.label}
            kind={provider.kind}
            budget={budgetById.get(provider.id)}
            loading={budgets.isPending}
          />
        ))}
      </div>
    </ChartCard>
  )
}
