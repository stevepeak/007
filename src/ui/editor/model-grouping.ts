import type { ModelOption, ModelProvider } from '../../engine/config'

/** Bucket models under the provider the host declared for them, in declared
 * order. Orphans (no matching provider) fall into a synthetic trailing group so
 * nothing is silently hidden. Shared by the model picker and the run-config
 * dialog. */
export function groupModelsByProvider(
  models: ModelOption[],
  providers: ModelProvider[],
): { provider: ModelProvider; models: ModelOption[] }[] {
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
      },
      models: orphans,
    })
  }
  return declared
}
