import { Extension } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'

import { cn } from '../cn'

// A focused prompt-body editor. The document is plain text — `${token}`
// variables are rendered as inline chips via a decoration plugin, so the
// serialized body stays exactly `${token}` (no custom node schema, trivial
// save/publish). `onChange` reports the plain body; `registerSetBody` hands the
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

// Plain body text → a doc with one paragraph per line.
function bodyToContent(body: string) {
  const lines = body.length ? body.split('\n') : ['']
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  }
}

export type PromptBodyEditorProps = {
  initialBody: string
  onChange: (body: string) => void
  editable?: boolean
  placeholder?: string
  className?: string
  /** Receives an imperative setter so the parent can replace the body. */
  registerSetBody?: (setBody: (body: string) => void) => void
}

export function PromptBodyEditor({
  initialBody,
  onChange,
  editable = true,
  placeholder = 'Write the prompt… use ${variable} to inject values.',
  className,
  registerSetBody,
}: PromptBodyEditorProps) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Placeholder.configure({ placeholder }),
      VariableChips,
    ],
    content: bodyToContent(initialBody),
    editorProps: {
      attributes: { class: 'prompt-body-content outline-none' },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getText({ blockSeparator: '\n' }))
    },
  })

  useEffect(() => {
    if (editor) editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (!editor || !registerSetBody) return
    registerSetBody((body: string) => {
      // Replace content without emitting an onChange (parent already has it).
      editor.commands.setContent(bodyToContent(body), { emitUpdate: false })
    })
  }, [editor, registerSetBody])

  return (
    <EditorContent
      editor={editor}
      className={cn(
        'min-h-[12rem] whitespace-pre-wrap rounded-md border border-neutral-300 px-3 py-2 text-sm leading-relaxed focus-within:border-neutral-500 [&_.ProseMirror]:min-h-[11rem] [&_.ProseMirror]:outline-none',
        className,
      )}
    />
  )
}
