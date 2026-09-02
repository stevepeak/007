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
  toAbsolute,
  type Target,
} from './target'

// "Connect a client" — how an MCP client points itself at THIS deployment, and
// what it gets when it does.
//
// It lives in the SDK rather than in a host page for the same reason the tool
// list is generated rather than typed: the answer is a property of the build.
// The origin comes from the browser, the tool list from the catalog `wf-mcp`
// registers, and the only thing a host supplies is how its checkout starts the
// process (`command`) — because that is the only part the SDK genuinely cannot
// know.
//
// Deliberately says nothing about the credential beyond its NAME. A page inside
// the workflow console is not a place to put a shared secret, and the person
// reading it either has the token already or has to be given it out of band.
//
// The one thing readers get wrong: `wf-mcp` is a stdio server, so the process
// always runs on the READER'S machine, whichever deployment it is pointed at.
// Nothing is deployed and there is no production instance of it. Only
// `WF_BASE_URL` moves. The page used to imply otherwise by showing one origin
// next to a local path, hence the Development / Production picker — it changes
// the target, never the command.

/** Default route the SDK's handlers are mounted at (`createWfSdkHandlers`). */
const DEFAULT_API_PATH = '/api/wf'

/**
 * The documented way to start the server: the bin `@stevepeak/007` ships.
 * Resolves from any workspace that has the package as a dependency.
 */
const DEFAULT_COMMAND = 'bunx wf-mcp'

export type McpConnectProps = {
  /**
   * How this host's checkout starts `wf-mcp`. Defaults to `bunx wf-mcp`, which
   * needs a cwd that depends on `@stevepeak/007` — a monorepo whose ROOT does
   * not (bins are linked per workspace) should pass the bin's source path
   * instead, e.g. `bun ~/app/packages/007/src/cli/mcp.ts`.
   */
  command?: string
  /** Route the data handlers are mounted at. Defaults to `/api/wf`. */
  apiPath?: string
  className?: string
}

export function McpConnect({
  command = DEFAULT_COMMAND,
  apiPath = DEFAULT_API_PATH,
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
            this console shows a person, exposed to an AI client over stdio.
            Every call goes through the one mounted route, so it gets the same
            validation and lands in the same change log as a click in here.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:max-w-md">
          <Stat value={tools.length} label="tools" />
          <Stat value={reads} label="read, always on" />
          <Stat value={writes} label="write, behind a flag" />
        </div>
      </header>

      <Section
        title="Register the server"
        lead="Pick which deployment to talk to, then copy the snippet for your client. Supply the token out of band — it is a deployment secret, and this page deliberately does not know it."
      >
        <TargetPicker target={target} onChange={setTarget} origin={origin} />
        <TargetNote target={target} known={known} />
        <ConnectSnippets
          baseUrl={baseUrl}
          command={command}
          apiPath={apiPath}
        />
      </Section>

      <Section
        title="Configuration"
        lead="Read from the environment; a flag of the same name wins over it. Nothing is baked into the SDK — no origin, no route, no credential."
      >
        <EnvTable baseUrl={baseUrl} apiPath={apiPath} />
        <p className="text-xs text-neutral-500">
          Add <code className="font-mono">--write</code> to the command to
          register the {writes} mutating tools. Off is the default, and off means
          they are not registered at all — a read-only session has no write tool
          to be talked into calling.
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
        lead="Two capabilities are withheld on purpose, and one identity is asserted."
      >
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white text-sm">
          <Limit title="Publish a version.">
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
          <Limit title="Borrow your name.">
            A bearer caller acts as its own service identity, never as the
            person who minted the token. The change feed is the only
            who-touched-this record here, so machine edits read as machine
            edits.
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
    blurb: 'Your deployed app. Same client, different URL and token.',
  },
]

/**
 * Which deployment the snippets below point at.
 *
 * Two large buttons rather than a third row of tabs: this choice decides which
 * database a client is about to read and which secret it needs, and it deserves
 * more weight than the client picker underneath it. Each shows the URL it will
 * produce, so the difference is visible before anything is copied.
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
 * `wf-mcp` speaks stdio: the client spawns it as a subprocess on the reader's
 * own machine and there is no deployed copy of it anywhere. So "connecting to
 * production" is one environment variable, not a different install — and the
 * command below is identical under both buttons. Readers reliably assume the
 * opposite.
 */
function TargetNote({ target, known }: { target: Target; known: boolean }) {
  return (
    <p className="text-xs text-neutral-500">
      The server runs on <strong className="font-medium">your machine</strong>{' '}
      either way — it is a stdio subprocess your client spawns, not something
      deployed. Only <code className="font-mono">WF_BASE_URL</code> and the
      token change.{' '}
      {known ? (
        <>
          This is the deployment serving this page, so the URL below is exact.
        </>
      ) : (
        <>
          This page is not being served from {target}, so it cannot know that
          URL — replace the placeholder with your own origin, and use{' '}
          <strong className="font-medium">that deployment’s</strong> token, not
          this one’s. Opening this page there fills it in for you.
        </>
      )}
    </p>
  )
}

/** Render a command string as an MCP config's `command` + `args` pair. */
function serverBlock(
  command: string,
  baseUrl: string,
  token: string,
  apiPath: string,
): string {
  const [bin, ...args] = command.split(' ')
  const env: [string, string][] = [
    ['WF_BASE_URL', baseUrl],
    ['WF_MCP_TOKEN', token],
  ]
  // Only worth stating when it is not the default the CLI already assumes.
  if (apiPath !== DEFAULT_API_PATH) env.push(['WF_API_PATH', apiPath])
  // Assembled line by line rather than with `JSON.stringify(…, null, n)`: this
  // is a fragment nested eight columns into a literal, and no indent argument
  // produces that. Each value still goes through `JSON.stringify`, so a path
  // containing a quote or a backslash stays valid JSON.
  const envLines = env
    .map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n')
  return `{
  "mcpServers": {
    "wf": {
      "command": ${JSON.stringify(bin)},
      "args": ${JSON.stringify(args)},
      "env": {
${envLines}
      }
    }
  }
}`
}

const CLIENTS = [
  { key: 'cli', label: 'Claude Code' },
  { key: 'project', label: '.mcp.json' },
  { key: 'desktop', label: 'Claude Desktop' },
]

/**
 * The same registration, three shapes.
 *
 * Shown side by side rather than as one canonical snippet because the
 * differences are the part people get wrong: Claude Code takes repeated `--env`
 * flags before a `--` separator, `.mcp.json` expands `${VAR}` so the secret
 * never has to be checked in, and Claude Desktop inherits no shell, so nothing
 * in its config may lean on `PATH`, `~`, or an exported variable.
 */
function ConnectSnippets({
  baseUrl,
  command,
  apiPath,
}: {
  baseUrl: string
  command: string
  apiPath: string
}) {
  const [client, setClient] = useState('cli')

  const cli = [
    'claude mcp add wf \\',
    `  --env WF_BASE_URL=${baseUrl} \\`,
    '  --env WF_MCP_TOKEN=$WF_MCP_TOKEN \\',
    `  -- ${command}`,
  ].join('\n')

  const desktopCommand = toAbsolute(command)

  return (
    <div className="space-y-3">
      <Tabs tabs={CLIENTS} active={client} onChange={setClient} />

      {client === 'cli' && (
        <>
          <CodeBlock code={cli} caption="terminal" />
          <p className="text-xs text-neutral-500">
            Registers the server for the current project — add{' '}
            <code className="font-mono">--scope user</code> to get it everywhere.
          </p>
        </>
      )}

      {client === 'project' && (
        <>
          <CodeBlock
            code={serverBlock(command, baseUrl, '${WF_MCP_TOKEN}', apiPath)}
            caption=".mcp.json"
          />
          <p className="text-xs text-neutral-500">
            Checked in at the repo root, so everyone on the project gets the same
            server. <code className="font-mono">{'${WF_MCP_TOKEN}'}</code> is
            expanded from the environment when the client starts, which is what
            keeps the secret out of the file.
          </p>
        </>
      )}

      {client === 'desktop' && (
        <>
          <CodeBlock
            code={serverBlock(desktopCommand, baseUrl, '…', apiPath)}
            caption="~/Library/Application Support/Claude/claude_desktop_config.json"
          />
          <p className="text-xs text-neutral-500">
            The same block with nothing left to a shell: Claude Desktop inherits
            no environment, so every{' '}
            <code className="font-mono">/absolute/path/to/…</code> above has to
            become a real one (<code className="font-mono">which bun</code>{' '}
            finds the runtime), and the token has to be a literal value rather
            than a variable reference.
          </p>
        </>
      )}
    </div>
  )
}

function EnvTable({ baseUrl, apiPath }: { baseUrl: string; apiPath: string }) {
  const rows = [
    {
      name: 'WF_BASE_URL',
      value: baseUrl,
      note: 'Origin of this deployment, or the full data-API URL. Required.',
    },
    {
      name: 'WF_MCP_TOKEN',
      value: '…',
      note: 'Shared secret matching the host’s. Required — an unset secret on the server means the door is closed.',
    },
    {
      name: 'WF_API_PATH',
      value: apiPath,
      note: 'Where the data handlers are mounted. Only set it if that moves.',
    },
    {
      name: 'WF_MCP_TIMEOUT_MS',
      value: '120000',
      note: 'Per-call budget. Generous by default — a model waits happily, and a dashboard read is slower than a spinner would tolerate.',
    },
  ]
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <table className="w-full text-left text-sm">
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.name}
              className="border-b border-neutral-200 last:border-b-0"
            >
              <th
                scope="row"
                className="w-56 px-4 py-3 align-top font-mono text-xs font-medium text-neutral-900"
              >
                {r.name}
                <div className="mt-1 font-mono text-[11px] break-all text-neutral-400">
                  {r.value}
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
 * Split by the `--write` gate rather than by subject area, because that split is
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
            note="Always available."
            tools={matches.filter((t) => t.readOnly)}
          />
          <ToolGroup
            title="Write"
            note="Registered only when the server is started with --write."
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
