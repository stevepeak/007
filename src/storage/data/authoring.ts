// Data-access for the authoring domain: workflows, agents, their shared
// version/draft lifecycle, run-manifest resolution, and trigger assignments.
// Pure functions over a `WfDb` handle — no auth, no tenancy (one global set).
//
// This is a thin re-export barrel. The implementation lives in cohesive sibling
// modules (`authoring-workflows`, `authoring-agents`, `authoring-manifest`),
// which share the pure graph-walk helpers in `authoring-graph` (kept out of this
// barrel so those internals stay private). Import from `./authoring` as before.

export * from './authoring-workflows'
export * from './authoring-agents'
export * from './authoring-manifest'
