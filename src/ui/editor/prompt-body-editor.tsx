import { Extension } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'

import { cn } from '../cn'

// A focused prompt-body editor. The document is authored as rich text but
// serialized to Markdown — headings, **bold**, lists, `code`, etc. round-trip
// through the stored body (which is what the LLM receives). `${token}`
// variables are rendered as inline chips via a decoration plugin; since they
// use no Markdown-special characters they serialize back verbatim as
// `${token}`. `onChange` reports the Markdown body; `registerSetBody` hands the
// parent an imperative setter for restore / version-load.

const VARIABLE_RE = /\$\{(\w+)\}/g

// Decorate every `${token}` run in the doc as a chip (purely visual — the text
// underneath is unchanged).
const VariableChips = Extension.create({
  name: 'promptVariableChips',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return
              for (const m of node.text.matchAll(VARIABLE_RE)) {
                const from = pos + (m.index ?? 0)
                decorations.push(
                  Decoration.inline(from, from + m[0].length, {
                    class:
                      'rounded bg-indigo-100 px-1 py-0.5 font-medium text-indigo-700',
                  }),
                )
              }
            })
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})

export type PromptBodyEditorProps = {
  initialBody: string
  onChange: (body: string) => void
  editable?: boolean
  placeholder?: string
  className?: string
  /** Receives an imperative setter so the parent can replace the body. */
  registerSetBody?: (setBody: (body: string) => void) => void
}

// Prose styling for the rendered Markdown. There's no Tailwind Typography
// plugin in this package, so the block/inline elements are styled directly via
// arbitrary variants on the ProseMirror root.
const PROSE_CLASSES = cn(
  '[&_.ProseMirror]:min-h-[11rem] [&_.ProseMirror]:outline-none',
  '[&_.ProseMirror>*+*]:mt-2',
  '[&_.ProseMirror_h1]:mt-4 [&_.ProseMirror_h1]:text-lg [&_.ProseMirror_h1]:font-semibold',
  '[&_.ProseMirror_h2]:mt-3 [&_.ProseMirror_h2]:text-base [&_.ProseMirror_h2]:font-semibold',
  '[&_.ProseMirror_h3]:mt-3 [&_.ProseMirror_h3]:text-sm [&_.ProseMirror_h3]:font-semibold',
  '[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5',
  '[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5',
  '[&_.ProseMirror_li]:my-0.5',
  '[&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-neutral-300 [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-neutral-600',
  '[&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-neutral-100 [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:font-mono [&_.ProseMirror_code]:text-[0.85em]',
  '[&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:bg-neutral-900 [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:text-neutral-100',
  '[&_.ProseMirror_pre_code]:bg-transparent [&_.ProseMirror_pre_code]:p-0 [&_.ProseMirror_pre_code]:text-neutral-100',
  '[&_.ProseMirror_hr]:my-3 [&_.ProseMirror_hr]:border-neutral-200',
)

export function PromptBodyEditor({
  initialBody,
  onChange,
  editable = true,
  placeholder = 'Write the prompt… use Markdown to format and ${variable} to inject values.',
  className,
  registerSetBody,
}: PromptBodyEditorProps) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit,
      // Single newlines behave as line breaks (as the old plain-text editor
      // did), so authors' intra-paragraph line spacing is preserved.
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      Placeholder.configure({ placeholder }),
      VariableChips,
    ],
    content: initialBody,
    contentType: 'markdown',
    editorProps: {
      attributes: { class: 'prompt-body-content outline-none' },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getMarkdown())
    },
  })

  useEffect(() => {
    if (editor) editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (!editor || !registerSetBody) return
    registerSetBody((body: string) => {
      // Replace content without emitting an onChange (parent already has it).
      editor.commands.setContent(body, {
        contentType: 'markdown',
        emitUpdate: false,
      })
    })
  }, [editor, registerSetBody])

  return (
    <EditorContent
      editor={editor}
      className={cn(
        'min-h-[12rem] rounded-md border border-neutral-300 px-3 py-2 text-sm leading-relaxed focus-within:border-neutral-500',
        PROSE_CLASSES,
        className,
      )}
    />
  )
}
