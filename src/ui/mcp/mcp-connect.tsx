import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  describeToolCatalog,
  type WfMcpToolDescription,
} from '../../mcp/describe'
import { cn } from '../cn'
import { Tabs } from '../filters'
import { DEFAULT_WF_SECTIONS } from '../wf-hub'

import {
  groupByCategory,
  type ToolCategory,
} from './categories'
import { CodeBlock } from './code-block'
import { PLACEHOLDER } from './target'

// "Connect a client" — how an MCP client points itself at THIS deployment, and
// what it gets when it does.
//
// It lives in the SDK rather than in a host page for the same reason the tool
// list is generated rather than typed: the answer is a property of the build.
// The origin comes from the browser and the tool list from the catalog the
// server registers, so a host supplies only where it mounted the endpoints.
//
// The page used to be mostly about a secret. It no longer mentions one, because
// there isn't one: the server is an HTTP endpoint behind the host's own OAuth,
// and a client authorizes by sending the reader through a browser sign-in they
// have already done. Nothing to copy, nothing to rotate, nothing to leak — and
// the change feed names the person instead of a service account.
//
// The thing readers now get wrong is the opposite of what they used to: they
// expect to install something. There is nothing to install and no process to
// run. A URL is the entire registration.

/** Where the read endpoint is mounted by default. */
const DEFAULT_MCP_PATH = '/api/mcp'

export type McpConnectProps = {
  /**
   * Route the read-only MCP endpoint is mounted at. Defaults to `/api/mcp`.
   * The write endpoint is assumed to be this path plus `/write`, which is how
   * `createWfMcpHandler` is mounted in the reference host.
   */
  mcpPath?: string
  className?: string
}

export function McpConnect({
  mcpPath = DEFAULT_MCP_PATH,
  className,
}: McpConnectProps) {
  // Computed once — the catalog is static for the bundle's lifetime.
  const tools = useMemo(() => describeToolCatalog(), [])

  // The deployment serving this page, which is the only one whose URL can be
  // known. There is no development/production picker: 007 is whitelabeled and
  // cannot know anyone's other hostname, so offering the choice meant offering
  // one real URL beside one invented one — and the invented one is exactly the
  // thing that gets pasted into a config and then fails to resolve. Open this
  // page on the deployment you want to connect to and the snippet is right.
  //
  // Guarded for SSR: the SDK is imported by hosts that server-render.
  const baseUrl =
    typeof window === 'undefined'
      ? PLACEHOLDER.development
      : window.location.origin

  return (
    <div className={cn('mx-auto max-w-4xl space-y-10 p-6', className)}>
      <header>
        <h1 className="text-lg font-semibold text-neutral-900">
          Connect over MCP
        </h1>
        <p className="max-w-2xl text-sm text-neutral-500">
          Agents, workflows, run traces, feedback and evals — the same things
          this console shows a person, exposed to an AI client over HTTP. You
          sign in with your own account, so every call goes through the same
          validation as a click in here and lands in the same change log{' '}
          <em>under your name</em>.
        </p>
      </header>

      <Section
        title="Register the server"
        lead="Copy the snippet for your client. There is no token to supply — the first call opens a browser and you approve it as yourself, and each deployment signs its own tokens, so authorizing here grants nothing anywhere else."
      >
        <ConnectSnippets baseUrl={baseUrl} mcpPath={mcpPath} />
      </Section>

      <Section
        title="Tools"
        lead="What it can do."
      >
        <ToolCatalog tools={tools} />
      </Section>

      <Section
        title="What it will not do"
        lead="Two capabilities are withheld on purpose, and one identity is now asserted rather than hidden."
      >
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white text-sm">
          <Limit title="Publish an agent version.">
            There is no <code className="font-mono">publish_agent</code>. A
            published version floats into every workflow referencing that agent,
            so it stays a decision a person makes in the editor. A client can
            rewrite a draft and grade it; shipping it is someone’s call.
          </Limit>
          <Limit title="Execute a tool for real.">
            <code className="font-mono">run_agent_preview</code> simulates every
            tool — the model writes plausible results rather than any record
            being touched. It tests prompts and tool choice; it is not evidence
            an answer is correct.
          </Limit>
          <Limit title="Act anonymously.">
            It uses <em>your</em> name, deliberately. Every change an AI client
            makes here is recorded against the account that authorized it and
            marked as having come through the MCP, so the activity feed can tell
            your clicks from your agent’s edits.
          </Limit>
        </ul>
      </Section>
    </div>
  )
}

// ── Layout bits ───────────────────────────────────────────────────────────────

function Section({
  title,
  lead,
  children,
}: {
  title: string
  lead: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        <p className="max-w-2xl text-xs text-neutral-500">{lead}</p>
      </div>
      {children}
    </section>
  )
}

function Limit({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="px-4 py-3">
      <span className="font-medium text-neutral-900">{title}</span>{' '}
      <span className="text-neutral-500">{children}</span>
    </li>
  )
}

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * A labelled on/off switch, styled to match the console's own (see the model
 * toggle on the Models page) so the control means the same thing in both places.
 */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 py-2 text-sm text-neutral-600 transition-colors hover:text-neutral-900"
    >
      <span
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-emerald-500' : 'bg-neutral-200',
        )}
      >
        <span
          className={cn(
            'inline-flex size-4 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
      {label}
    </button>
  )
}

const CLIENTS = [
  { key: 'cli', label: 'Claude Code' },
  { key: 'project', label: '.mcp.json' },
  { key: 'desktop', label: 'Claude Desktop' },
]

/**
 * The same registration, three shapes, two scopes.
 *
 *
 * Shown side by side because the differences are the part people get wrong:
 * Claude Code needs `--transport http` (without it, it tries to run the URL as
 * a command), `.mcp.json` is checked in and now holds nothing secret, and
 * Desktop has no config file for this at all — remote servers are added in the
 * UI.
 *
 * ── Why the scope is a toggle here rather than a section below ────────────────
 *
 * Read and write are two URLs, and that used to be explained in a table further
 * down the page. But the fact only matters at the moment someone copies a
 * snippet — which URL goes in the command IS the decision — so it belongs on the
 * snippet rather than a scroll away from it. Flipping the toggle rewrites the
 * command, so the difference is something you see rather than something you read
 * and then have to apply.
 */
function ConnectSnippets({
  baseUrl,
  mcpPath,
}: {
  baseUrl: string
  mcpPath: string
}) {
  const [client, setClient] = useState('cli')
  // Defaults ON. The authoring tools are what most people come here to register,
  // and a reader who only wants reads is far likelier to notice a switch they
  // have to turn OFF than to find one they never turned on.
  const [write, setWrite] = useState(true)
  const readUrl = `${baseUrl}${mcpPath}`
  // The write endpoint is the read path plus `/write` — see `mcpPath`.
  const url = write ? `${readUrl}/write` : readUrl
  // Named so the two can be registered side by side: a session that only ever
  // wanted to read should not be holding a token that can author.
  const serverName = write ? '007-write' : '007'

  const cli = `claude mcp add --transport http ${serverName} ${url}`

  const projectJson = `{
  "mcpServers": {
    ${JSON.stringify(serverName)}: {
      "type": "http",
      "url": ${JSON.stringify(url)}
    }
  }
}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <Tabs tabs={CLIENTS} active={client} onChange={setClient} />
        {/* A switch, not a second tab strip: this is one thing being turned on
            or off, and rendering it like the client picker made it read as
            another set of mutually-exclusive destinations. */}
        <Switch
          checked={write}
          onChange={setWrite}
          label="Include write tools"
        />
      </div>

      <p className="text-xs text-neutral-500">
        {write ? (
          <>
            <code className="font-mono">wf:write</code> — the read tools plus the
            ones that author: drafts, eval Samples, retrying a run, and
            publishing a workflow version, which changes what customers get. A
            second endpoint rather than a flag, so it prompts for its own
            consent.
          </>
        ) : (
          <>
            <code className="font-mono">wf:read</code> — everything this console
            can show you, and nothing that changes a record. A read-only session
            has no write tool registered to be talked into calling.
          </>
        )}
      </p>

      {client === 'cli' && (
        <>
          <CodeBlock code={cli} caption="terminal" />
          <p className="text-xs text-neutral-500">
            Registers it for you in <em>this</em> directory. Add{' '}
            <code className="font-mono">--scope user</code> to register it for
            yourself in every project on this machine instead, so you never do
            this again — or{' '}
            <code className="font-mono">--scope project</code>, which writes the{' '}
            <code className="font-mono">.mcp.json</code> on the next tab and
            shares it with everyone on the repo.
          </p>
          <p className="text-xs text-neutral-500">
            Then run <code className="font-mono">/mcp</code> and pick{' '}
            <strong className="font-medium">Authenticate</strong>; your browser
            opens and comes back signed in. Whichever scope you picked, the
            sign-in is yours alone — a shared{' '}
            <code className="font-mono">.mcp.json</code> shares the{' '}
            <em>server</em>, never a credential.
          </p>
        </>
      )}

      {client === 'project' && (
        <>
          <CodeBlock code={projectJson} caption=".mcp.json" />
          <p className="text-xs text-neutral-500">
            Checked in at the repo root, so everyone on the project gets the
            same server — and each of them authorizes as themselves the first
            time they use it. This file now holds nothing that needs protecting,
            which is the point: there is no{' '}
            <code className="font-mono">env</code> block and no variable to
            expand.
          </p>
        </>
      )}

      {client === 'desktop' && (
        <>
          <CodeBlock code={url} caption="Settings → Connectors → Add" />
          <p className="text-xs text-neutral-500">
            Desktop has no config file for remote servers: add it as a custom
            connector and paste the URL. It runs the same browser sign-in, and
            because nothing is spawned as a subprocess there is no absolute path
            to get right.
          </p>
        </>
      )}
    </div>
  )
}

// ── Tool catalog ──────────────────────────────────────────────────────────────

/**
 * The console's own icon for each subject, by nav key.
 *
 * Borrowed rather than re-chosen: the hub is where a reader already learned that
 * a `Target` means evals here, and picking a second icon for the same subject
 * would give it two identities one scroll apart. Following `DEFAULT_WF_SECTIONS`
 * also means a nav that changes its mind drags this along with it.
 */
const NAV_ICONS = new Map(DEFAULT_WF_SECTIONS.map((s) => [s.key, s.icon]))

/**
 * The matching tint, as literal class strings.
 *
 * NOT derived from the hub's `accent`, whose resting half colors only the glyph
 * (`text-indigo-600`) and whose tint is hover-only (`group-hover:bg-indigo-100`)
 * because a card lights up under the cursor. These headings are static and want
 * the tint at rest — and Tailwind v4 scans for literals, so a computed
 * `bg-${hue}-50` would produce no CSS at all.
 * Same palette, same source of truth for WHICH hue; only the state differs.
 */
const NAV_TINTS: Record<string, string> = {
  workflows: 'bg-indigo-50 text-indigo-600',
  agents: 'bg-violet-50 text-violet-600',
  evals: 'bg-rose-50 text-rose-600',
  runs: 'bg-sky-50 text-sky-600',
  connectors: 'bg-amber-50 text-amber-600',
  tools: 'bg-emerald-50 text-emerald-600',
  models: 'bg-amber-50 text-amber-600',
  feedback: 'bg-teal-50 text-teal-600',
  activity: 'bg-slate-100 text-slate-600',
}

/**
 * The catalog, grouped by SUBJECT and collapsed by default.
 *
 * Two changes from what this was. It grouped by the write gate, which is the
 * split the server enforces but not the one a reader is asking about — they want
 * to know what this thing can do about workflows, and the endpoint toggle above
 * already answers the scope question. And it rendered every tool's full
 * description at once: fifty-odd verbatim prompts, which is a wall of text in
 * place of an index.
 *
 * So subjects are accordions and each tool is its own disclosure. A collapsed
 * page is a list of nine headings; everything else is one click away.
 *
 * There is no filter box. With the catalog collapsed to its subjects the whole
 * surface fits on one screen, and a search that has to open groups to show a
 * match fights the collapse it is searching inside — the browser's own find
 * does the remaining job on a page this size.
 */
function ToolCatalog({ tools }: { tools: WfMcpToolDescription[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const groups = useMemo(() => groupByCategory(tools), [tools])

  return (
    <div className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white">
      {groups.map(({ category, tools: inGroup }) => (
        <CategorySection
          key={category.key}
          category={category}
          tools={inGroup}
          open={open[category.key] ?? false}
          onToggle={() => { return setOpen((prev) => ({
              ...prev,
              [category.key]: !(prev[category.key] ?? false),
            })) }
          }
        />
      ))}
    </div>
  )
}

function CategorySection({
  category,
  tools,
  open,
  onToggle,
}: {
  category: ToolCategory
  tools: WfMcpToolDescription[]
  open: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-neutral-50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-neutral-400 transition-transform',
            open && 'rotate-90',
          )}
        />
        <CategoryIcon navKey={category.navKey} />
        <span className="text-sm font-medium text-neutral-900">
          {category.title}
        </span>
        <span className="text-xs tabular-nums text-neutral-400">
          {tools.length}
        </span>
        <span className="hidden truncate text-xs text-neutral-500 sm:block">
          {category.blurb}
        </span>
      </button>
      {open && (
        <ul className="border-t border-neutral-100">
          {tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The subject's chip — the console's icon in the console's colour.
 *
 * Renders nothing rather than a placeholder if the nav key resolves to no
 * section: a missing icon is a gap someone notices, and a generic stand-in is
 * one they don't. `categories.test.ts` makes sure it cannot happen anyway.
 */
function CategoryIcon({ navKey }: { navKey: string }) {
  const Icon = NAV_ICONS.get(navKey)
  if (!Icon) return null
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md',
        NAV_TINTS[navKey] ?? 'bg-neutral-100 text-neutral-500',
      )}
    >
      <Icon className="size-3.5" />
    </span>
  )
}

/**
 * One tool, collapsed to its name.
 *
 * The description is shown VERBATIM when expanded — it is the prompt the model
 * is given, so paraphrasing it here would document a server that doesn't exist.
 * That is also why it is worth hiding: these are written to be read by a model
 * mid-task, and several run to a dozen lines.
 */
function ToolRow({ tool }: { tool: WfMcpToolDescription }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="border-b border-neutral-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 py-2 pr-4 pl-10 text-left transition-colors hover:bg-neutral-50"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-neutral-300 transition-transform',
            open && 'rotate-90',
          )}
        />
        <code className="font-mono text-sm font-medium text-neutral-900">
          {tool.name}
        </code>
        <span className="text-xs text-neutral-400">{tool.title}</span>
        {/* The gate, as a badge rather than a grouping: it is one property of a
            tool, not the thing a reader came here to browse by. */}
        {!tool.readOnly && (
          <span className="rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
            write
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 pb-3 pr-4 pl-10">
          <p className="max-w-3xl text-sm whitespace-pre-line text-neutral-500">
            {tool.description}
          </p>
          {tool.args.length > 0 && (
            <dl className="grid max-w-3xl gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,10rem)_1fr]">
              {tool.args.map((arg) => (
                <div key={arg.name} className="contents">
                  <dt className="flex items-baseline gap-1.5 pt-0.5">
                    <code className="font-mono text-xs text-neutral-800">
                      {arg.name}
                    </code>
                    <span className="font-mono text-[10px] text-neutral-400">
                      {arg.type}
                    </span>
                    {arg.required && (
                      <span
                        className="text-[10px] text-rose-500"
                        title="Required"
                      >
                        *
                      </span>
                    )}
                  </dt>
                  <dd className="pb-1 text-xs text-neutral-500">
                    {arg.description}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </li>
  )
}
