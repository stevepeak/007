import type { ModelOption, ModelProvider } from '../../engine/config'

/** A provider and the models the host declared under it. */
export type ModelGroup<
  M extends GroupableModel = ModelOption,
  P extends GroupableProvider = ModelProvider,
> = { provider: P; models: M[] }

type GroupableModel = { id: string; providerId?: string }
// `kind` admits 'custom' in every catalog that groups (chat and decision), which
// is what the synthetic trailing group claims to be.
type GroupableProvider = { id: string; label: string; kind: string }

/** Bucket models under the provider the host declared for them, in declared
 * order. Orphans (no matching provider) fall into a synthetic trailing group so
 * nothing is silently hidden. Shared by the chat and decision model pickers and
 * the run-config dialog. */
export function groupModelsByProvider<
  M extends GroupableModel,
  P extends GroupableProvider,
>(models: M[], providers: P[]): ModelGroup<M, P>[] {
  const declared = providers
    .map((provider) => ({
      provider,
      models: models.filter((m) => m.providerId === provider.id),
    }))
    .filter((g) => g.models.length > 0)

  const claimed = new Set(declared.flatMap((g) => g.models.map((m) => m.id)))
  const orphans = models.filter((m) => !claimed.has(m.id))
  if (orphans.length > 0) {
    declared.push({
      provider: {
        id: '__ungrouped__',
        label: providers.length > 0 ? 'Other' : 'Models',
        kind: 'custom',
      } as P,
      models: orphans,
    })
  }
  return declared
}
