// Canonical model/provider shapes live in the host-injection contract; re-export
// them so the wire client and the UI import from one place.
export type {
  AgentUsageRef,
  ModelCapabilities,
  ModelCatalog,
  ModelCatalogEntry,
  ModelOption,
  ModelProvider,
  ModelProviderKind,
  ModelProviderStatus,
} from '../engine/config'
