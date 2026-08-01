// Data-access for the authoring domain: workflows, agents, their shared
// version/draft lifecycle, run-manifest resolution, and trigger assignments.
// Pure functions over a `WfDb` handle — no auth, no tenancy (one global set).
//
// This is a thin re-export barrel. The implementation lives in cohesive sibling
// modules: `authoring-workflows` (CRUD + version/draft lifecycle) plus its
// focused satellites `authoring-workflows-stats` (list rollups),
// `authoring-workflows-references` (agent-usage scan), and
// `authoring-assignments` (trigger → workflow); `authoring-agents`; and
// `authoring-manifest`. They share the pure graph-walk helpers in
// `authoring-graph` (kept out of this barrel so those internals stay private).
// Import from `./authoring` as before.

export * from './authoring-workflows'
export * from './authoring-workflows-stats'
export * from './authoring-workflows-references'
export * from './authoring-assignments'
export * from './authoring-agents'
export * from './authoring-manifest'
