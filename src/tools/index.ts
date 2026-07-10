// Built-in tools shipped with the SDK. Provider-agnostic (fetch + injected
// deps), so a host can register them in its `toolRegistry` without pulling any
// vendor SDK. Each returns a full `ToolRegistryEntry` (end-user metadata + a
// deps-bound `build`).
export {
  createTavilyTool,
  type CreateTavilyToolOptions,
  type TavilyResult,
} from './tavily'
export { TAVILY_ICON_SVG } from './icons'
