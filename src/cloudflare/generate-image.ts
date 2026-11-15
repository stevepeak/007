import { z } from 'zod'

import type { ToolRegistryEntry } from '../engine/tool-registry'

// Cloudflare-native `generate_image` built-in: a text prompt → Workers AI FLUX
// → a JPEG in R2 under `images/<imageId>`. The tool returns the id, never the
// bytes: a base64 image would cost the model its context window and bloat the
// run recorder. A host turns the id into whatever "saved" means to it (a row,
// a library item) by reading the object at `generatedImageKey(imageId)`.

const DEFAULT_MODEL = '@cf/black-forest-labs/flux-1-schnell'
/** FLUX schnell's default step count; the model accepts up to 8. */
const DEFAULT_STEPS = 4

/** The R2 key a generated image is stored under. */
export function generatedImageKey(imageId: string): string {
  return `images/${imageId}`
}

export const generateImageInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      'What the image shows: subject, setting, style, composition and lighting, in plain words.',
    ),
  steps: z
    .number()
    .int()
    .min(1)
    .max(8)
    .nullish()
    .describe('Diffusion steps, 1-8: more is slower and sharper. Default 4.'),
})

export const generateImageOutputSchema = z.object({
  imageId: z
    .string()
    .describe('The stored image id — pass it to whatever saves or uses it.'),
  contentType: z.string(),
  size: z.number().describe('Bytes.'),
})

export type GenerateImageResult = z.infer<typeof generateImageOutputSchema>

export type CreateGenerateImageToolOptions<TDeps> = {
  getAI: (deps: TDeps) => Ai
  /** Where the image is written, at `generatedImageKey(imageId)`. */
  getBucket: (deps: TDeps) => R2Bucket
  /** Override the registry id (default `generate_image`). */
  id?: string
  icon?: string
  iconName?: string
  color?: string
}

/** Build a `generate_image` registry entry. */
export function createGenerateImageTool<TDeps>(
  opts: CreateGenerateImageToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  return {
    id: opts.id ?? 'generate_image',
    // Shipped by the SDK — see `ToolMeta.origin`.
    origin: 'sdk',
    name: 'Generate Image',
    description:
      'Generate an image from a text prompt. Returns an image id, not the picture — hand the id to a tool that saves or uses it.',
    icon: opts.icon,
    iconName: opts.iconName ?? 'ImagePlus',
    color: opts.color ?? 'violet',
    // Writes a new object every call; under simulate it must not spend a run.
    sideEffect: 'write',
    statusLabel: 'Generating an image',
    kind: 'function',
    inputSchema: generateImageInputSchema,
    outputSchema: generateImageOutputSchema,
    build: (deps) => {
      return async (rawArgs): Promise<GenerateImageResult> => {
        const args = generateImageInputSchema.parse(rawArgs)
        const { image } = await opts.getAI(deps).run(DEFAULT_MODEL, {
          prompt: args.prompt,
          steps: args.steps ?? DEFAULT_STEPS,
        })
        if (!image)
          throw new Error('generate_image: the model returned no image')
        const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0))
        const imageId = crypto.randomUUID()
        const contentType = 'image/jpeg'
        await opts.getBucket(deps).put(generatedImageKey(imageId), bytes, {
          httpMetadata: { contentType },
        })
        return { imageId, contentType, size: bytes.byteLength }
      }
    },
  }
}
