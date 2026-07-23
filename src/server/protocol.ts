export type {
  TriggerEventField,
  TriggerEventOption,
} from '../engine/trigger-registry'

// The wire protocol between the SDK's React UI and the host-mounted route
// handler. Kept framework-agnostic: pure types + DTOs, no React, no Drizzle.
// The host mounts `createWfSdkHandlers` at one route; the browser talks to it
// via `createHttpWfDataClient`. Tenant identity is resolved server-side (never
// trusted from the client), so it never appears in this interface.

export * from './protocol-agents'
export * from './protocol-client'
export * from './protocol-evals'
export * from './protocol-feedback'
export * from './protocol-models'
export * from './protocol-runs'
export * from './protocol-tools'
export * from './protocol-workflows'
