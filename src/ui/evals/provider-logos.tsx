import type { ComponentType, SVGProps } from 'react'

import { cn } from '../cn'

// Real vendor logomarks for the AI providers wired into 007. OpenAI and
// Anthropic render their official logomarks; Venice ("V") and OpenRouter (a
// routing glyph) use clean stylized marks as brand stand-ins until we embed
// their official vectors. Each logo inherits `currentColor` (via fill or
// stroke) so the surrounding tile controls its color.

export type ProviderId = 'openai' | 'anthropic' | 'venice' | 'openrouter'

type LogoProps = SVGProps<SVGSVGElement>

function OpenAILogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z" />
    </svg>
  )
}

function AnthropicLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.541Zm-.3712 10.2412 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  )
}

function VeniceLogo(props: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 5l8 14 8-14" />
    </svg>
  )
}

function OpenRouterLogo(props: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5.5 12h2.5" />
      <path d="M8 12c5 0 4-6 9-6" />
      <path d="M8 12c5 0 4 6 9 6" />
      <circle cx="3.6" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="6" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="18" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export type ProviderMeta = {
  id: ProviderId
  name: string
  /** Tile classes: subtle brand-tinted background + logo color (via currentColor). */
  tile: string
  Logo: ComponentType<LogoProps>
}

// The AI providers 007 ships logos for. Order is the display order anywhere the
// full list is rendered.
const AI_PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    tile: 'bg-emerald-50 text-emerald-600',
    Logo: OpenAILogo,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    tile: 'bg-orange-50 text-[#CC785C]',
    Logo: AnthropicLogo,
  },
  {
    id: 'venice',
    name: 'Venice',
    tile: 'bg-red-50 text-red-600',
    Logo: VeniceLogo,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tile: 'bg-sky-50 text-sky-700',
    Logo: OpenRouterLogo,
  },
]

const BY_ID = Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, p])) as Record<
  ProviderId,
  ProviderMeta
>

/** Look up a provider by id. Returns undefined for ids we have no logo for. */
export function getProvider(id: string | null | undefined): ProviderMeta | undefined {
  return id ? BY_ID[id as ProviderId] : undefined
}

/** A provider's logomark in a rounded tile — same footprint as BrandMark. */
export function ProviderLogo({
  id,
  className,
}: {
  id: ProviderId
  className?: string
}) {
  const provider = BY_ID[id]
  if (!provider) return null
  const { Logo } = provider
  return (
    <span
      title={provider.name}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded',
        provider.tile,
        className,
      )}
    >
      <Logo className="size-3.5" />
    </span>
  )
}
