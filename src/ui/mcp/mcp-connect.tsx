import { ChevronRight, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  describeToolCatalog,
  type WfMcpToolDescription,
} from '../../mcp/describe'
import { cn } from '../cn'
import { Tabs } from '../filters'

import { CodeBlock } from './code-block'
import {
  isLocalOrigin,
  PLACEHOLDER,
  resolveTarget,
  type Target,
} from './target'

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
  const reads = tools.filter((t) => t.readOnly).length
  const writes = tools.length - reads

  // Rendered client-side only, so the origin is simply where the reader is.
  // Guarded anyway: the SDK is imported by hosts that server-render.
  const origin =
    typeof window === 'undefined'
      ? PLACEHOLDER.development
      : window.location.origin

  // Open on whichever target this page is being served from — the one whose URL
  // is real. Someone reading the console on production is almost always there
  // to connect to production.
  const [target, setTarget] = useState<Target>(() => {
    return isLocalOrigin(origin) ? 'development' : 'production'
  })
  const { url: baseUrl, known } = resolveTarget(target, origin)

  return (
    <div className={cn('mx-auto max-w-4xl space-y-10 p-6', className)}>
      <header className="space-y-3">
        <div>
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
        </div>
        <div className="grid grid-cols-3 gap-3 sm:max-w-md">
          <Stat value={tools.length} label="tools" />
          <Stat value={reads} label="read" />
          <Stat value={writes} label="write, separate consent" />
        </div>
      </header>

      <Section
        title="Register the server"
        lead="Pick which deployment to talk to, then copy the snippet for your client. There is no token to supply — the first call opens a browser and you approve it as yourself."
      >
        <TargetPicker target={target} onChange={setTarget} origin={origin} />
        <TargetNote target={target} known={known} />
        <ConnectSnippets baseUrl={baseUrl} mcpPath={mcpPath} />
      </Section>

      <Section
        title="Signing in"
        lead="What happens the first time a client calls, and what it remembers afterwards."
      >
        <ol className="list-inside list-decimal space-y-2 rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
          <li>
            The client asks the endpoint for a tool list and gets a{' '}
            <code className="font-mono text-xs">401</code> naming the scope it
            needs.
          </li>
          <li>
            It registers itself and opens your browser at this app. If you are
            already signed in — you are, you are reading this — there is nothing
            to type.
          </li>
          <li>
            You approve the scopes once. The client stores the resulting token
            itself and refreshes it silently from then on.
          </li>
        </ol>
        <p className="text-xs text-neutral-500">
          Staff only: the endpoint checks that your account is firm staff before
          it registers a single tool, so a client account that somehow completes
          the sign-in still gets an empty server rather than a read of the
          workflow estate.
        </p>
      </Section>

      <Section
        title="Read and write are different URLs"
        lead="The write tools are not a flag on the client any more. They are a second endpoint that needs its own scope, and therefore its own consent."
      >
        <ScopeTable baseUrl={baseUrl} mcpPath={mcpPath} reads={reads} writes={writes} />
        <p className="text-xs text-neutral-500">
          This used to be a{' '}
          <code className="font-mono">--write</code> flag typed on the command
          that started the server, which is to say: a setting the client chose
          for itself. Now the token decides, and a read-only session has no
          write tool registered to be talked into calling.
        </p>
      </Section>

      <Section
        title="Tools"
        lead="Rendered from the server’s own catalog, descriptions included — this is the text the model is given, not a summary of it."
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

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
      <div className="text-xl font-semibold tabular-nums text-neutral-900">
        {value}
      </div>
      <div className="text-[11px] text-neutral-500">{label}</div>
    </div>
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

const TARGETS: { value: Target; title: string; blurb: string }[] = [
  {
    value: 'development',
    title: 'Development',
    blurb: 'The app running on your own machine.',
  },
  {
    value: 'production',
    title: 'Production',
    blurb: 'Your deployed app. Same client, different URL.',
  },
]

/**
 * Which deployment the snippets below point at.
 *
 * Two large buttons rather than a third row of tabs: this choice decides which
 * database a client is about to read, and it deserves more weight than the
 * client picker underneath it. Each shows the URL it will produce, so the
 * difference is visible before anything is copied.
 */
function TargetPicker({
  target,
  onChange,
  origin,
}: {
  target: Target
  onChange: (t: Target) => void
  origin: string
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {TARGETS.map((t) => {
        const on = t.value === target
        const { url, known } = resolveTarget(t.value, origin)
        return (
          <button
            key={t.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(t.value)}
            className={cn(
              'rounded-xl border p-4 text-left transition',
              on
                ? 'border-neutral-900 bg-white shadow-sm ring-1 ring-neutral-900'
                : 'border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-neutral-900">
                {t.title}
              </span>
              {known ? (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                  you are here
                </span>
              ) : (
                <span className="rounded-full border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                  placeholder
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-neutral-500">{t.blurb}</p>
            <code className="mt-2 block truncate font-mono text-[11px] text-neutral-600">
              {url}
            </code>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The sentence the picker exists to make sayable.
 *
 * Each deployment is its own authorization server, so a token minted against
 * one is refused by the other — audience-bound, not merely wrong. That is a
 * feature (a local experiment cannot reach production) and it is also the thing
 * someone will otherwise spend an afternoon on, so it is said out loud.
 */
function TargetNote({ target, known }: { target: Target; known: boolean }) {
  return (
    <p className="text-xs text-neutral-500">
      Each deployment signs its own tokens, so authorizing against one grants
      nothing on the other — the two are separate databases with separate
      version numbers, and the audience check keeps them that way.{' '}
      {known ? (
        <>
          This is the deployment serving this page, so the URL below is exact.
        </>
      ) : (
        <>
          This page is not being served from {target}, so it cannot know that
          URL — replace the placeholder with your own origin. Opening this page
          there fills it in for you.
        </>
      )}
    </p>
  )
}

const CLIENTS = [
  { key: 'cli', label: 'Claude Code' },
  { key: 'project', label: '.mcp.json' },
  { key: 'desktop', label: 'Claude Desktop' },
]

/**
 * The same registration, three shapes.
 *
 * Shown side by side because the differences are the part people get wrong:
 * Claude Code needs `--transport http` (without it, it tries to run the URL as
 * a command), `.mcp.json` is checked in and now holds nothing secret, and
 * Desktop has no config file for this at all — remote servers are added in the
 * UI.
 */
function ConnectSnippets({
  baseUrl,
  mcpPath,
}: {
  baseUrl: string
  mcpPath: string
}) {
  const [client, setClient] = useState('cli')
  const readUrl = `${baseUrl}${mcpPath}`
  const writeUrl = `${readUrl}/write`

  const cli = [
    `claude mcp add --transport http 007 ${readUrl}`,
    '',
    '# and, only if you need the authoring tools:',
    `claude mcp add --transport http 007-write ${writeUrl}`,
  ].join('\n')

  const projectJson = `{
  "mcpServers": {
    "007": {
      "type": "http",
      "url": ${JSON.stringify(readUrl)}
    }
  }
}`

  return (
    <div className="space-y-3">
      <Tabs tabs={CLIENTS} active={client} onChange={setClient} />

      {client === 'cli' && (
        <>
          <CodeBlock code={cli} caption="terminal" />
          <p className="text-xs text-neutral-500">
            Registers the server for the current project — add{' '}
            <code className="font-mono">--scope user</code> to get it
            everywhere. Then run <code className="font-mono">/mcp</code> and
            pick <strong className="font-medium">Authenticate</strong>; your
            browser opens and comes back signed in.
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
          <CodeBlock code={readUrl} caption="Settings → Connectors → Add" />
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

function ScopeTable({
  baseUrl,
  mcpPath,
  reads,
  writes,
}: {
  baseUrl: string
  mcpPath: string
  reads: number
  writes: number
}) {
  const rows = [
    {
      url: `${baseUrl}${mcpPath}`,
      scope: 'wf:read',
      note: `The ${reads} read tools. Everything this console can show you, and nothing that changes a record.`,
    },
    {
      url: `${baseUrl}${mcpPath}/write`,
      scope: 'wf:write',
      note: `The read tools plus the ${writes} that author — drafts, eval Samples, and publishing a workflow version, which changes what customers get.`,
    },
  ]
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-left text-sm">
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.scope}
              className="border-b border-neutral-200 last:border-b-0"
            >
              <th
                scope="row"
                className="w-72 px-4 py-3 align-top font-mono text-xs font-medium text-neutral-900"
              >
                {r.scope}
                <div className="mt-1 font-mono text-[11px] break-all text-neutral-400">
                  {r.url}
                </div>
              </th>
              <td className="px-4 py-3 align-top text-xs text-neutral-500">
                {r.note}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Tool catalog ──────────────────────────────────────────────────────────────

/** Everything a query can match, lowercased once per tool. */
function haystack(tool: WfMcpToolDescription): string {
  return [
    tool.name,
    tool.title,
    tool.description,
    ...tool.args.map((a) => `${a.name} ${a.description ?? ''}`),
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * Split by the write gate rather than by subject area, because that split is
 * the one the server actually enforces. A subject grouping would have to be
 * hand-maintained here and would go stale the first time a tool is added.
 */
function ToolCatalog({ tools }: { tools: WfMcpToolDescription[] }) {
  const [query, setQuery] = useState('')
  const indexed = useMemo(
    () => tools.map((tool) => ({ tool, text: haystack(tool) })),
    [tools],
  )
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tools
    return indexed.filter((e) => e.text.includes(q)).map((e) => e.tool)
  }, [indexed, query, tools])

  return (
    <div className="space-y-4">
      <div className="relative w-64">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tools…"
          aria-label="Filter tools"
          className="h-8 w-full rounded-md border border-neutral-300 bg-transparent pr-3 pl-8 text-sm outline-none focus:border-neutral-500"
        />
      </div>

      {matches.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No tool matches “{query.trim()}”.
        </p>
      ) : (
        <>
          <ToolGroup
            title="Read"
            note="Granted by wf:read."
            tools={matches.filter((t) => t.readOnly)}
          />
          <ToolGroup
            title="Write"
            note="Registered only for a session that holds wf:write."
            tools={matches.filter((t) => !t.readOnly)}
          />
        </>
      )}
    </div>
  )
}

function ToolGroup({
  title,
  note,
  tools,
}: {
  title: string
  note: string
  tools: WfMcpToolDescription[]
}) {
  if (tools.length === 0) return null
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 pb-1.5">
        <h3 className="text-xs font-semibold text-neutral-900">
          {title}{' '}
          <span className="font-normal text-neutral-400">({tools.length})</span>
        </h3>
        <p className="text-[11px] text-neutral-500">{note}</p>
      </div>
      <ul className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        {tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} />
        ))}
      </ul>
    </div>
  )
}

function ToolRow({ tool }: { tool: WfMcpToolDescription }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="border-b border-neutral-200 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-medium text-neutral-900">
          {tool.name}
        </code>
        <span className="text-xs text-neutral-400">{tool.title}</span>
        {!tool.readOnly && (
          <span className="rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
            write
          </span>
        )}
      </div>
      {/* Verbatim — it is the prompt the model is given, so paraphrasing it
          here would document a server that doesn't exist. */}
      <p className="mt-1 max-w-3xl text-sm whitespace-pre-line text-neutral-500">
        {tool.description}
      </p>
      {tool.args.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-neutral-500 transition-colors hover:text-neutral-900"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', open && 'rotate-90')}
            />
            {tool.args.length} argument{tool.args.length === 1 ? '' : 's'}
          </button>
          {open && (
            <dl className="mt-1.5 grid max-w-3xl gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,10rem)_1fr]">
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
                      <span className="text-[10px] text-rose-500" title="Required">
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
        </>
      )}
    </li>
  )
}
