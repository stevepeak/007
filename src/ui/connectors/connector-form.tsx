import { useState } from 'react'

import type { ConnectorSummary } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useSaveConnector } from '../hooks-connectors'

// Adding or editing a connector — one form for both, because the fields are
// the same and only the id's mutability differs.
//
// The id is asked for separately from the label and described as permanent,
// because it is: it becomes part of every one of this server's tool ids, which
// get frozen into published agent configs. Renaming later is a delete and a
// re-create, so it is worth one sentence here — and in edit mode the field is
// shown but locked, so the constraint is visible rather than merely enforced.

type AuthKind = ConnectorSummary['authKind']

export type ConnectorFormProps = {
  /** The connector being edited; omit to create a new one. */
  connector?: ConnectorSummary
  onDone: () => void
}

export function ConnectorForm({ connector, onDone }: ConnectorFormProps) {
  const { Button, Input, Label, Select } = useWfComponents()
  const save = useSaveConnector()
  const editing = !!connector
  const [id, setId] = useState(connector?.id ?? '')
  const [label, setLabel] = useState(connector?.label ?? '')
  const [url, setUrl] = useState(connector?.url ?? '')
  const [authKind, setAuthKind] = useState<AuthKind>(
    connector?.authKind ?? 'oauth2',
  )
  const [scopes, setScopes] = useState(connector?.scopes ?? '')
  const [note, setNote] = useState(connector?.note ?? '')

  // Said before Save, not after: a changed server or auth scheme drops the
  // stored credential (see `saveConnector`), and someone re-pointing a
  // connected connector should know they are about to sign in again.
  const willDisconnect =
    !!connector?.connection &&
    (url.trim() !== connector.url || authKind !== connector.authKind)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    save.mutate(
      {
        id: id.trim(),
        label: label.trim(),
        url: url.trim(),
        authKind,
        scopes: scopes.trim() || null,
        note: note.trim() || null,
      },
      { onSuccess: onDone },
    )
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="wf-connector-label">Name</Label>
          <Input
            id="wf-connector-label"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value)
              // Offer a slug, but let it be overridden — it is permanent.
              if (!editing && (!id || id === slugify(label))) {
                setId(slugify(e.target.value))
              }
            }}
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="wf-connector-id">Id</Label>
          <Input
            id="wf-connector-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            readOnly={editing}
            disabled={editing}
            required
          />
          <p className="text-xs text-neutral-500">
            Permanent — it becomes part of every tool id from this server.
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="wf-connector-url">Server URL</Label>
        <Input
          id="wf-connector-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="wf-connector-auth">Authentication</Label>
          <Select
            id="wf-connector-auth"
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as AuthKind)}
          >
            <option value="oauth2">Sign in with OAuth</option>
            <option value="bearer">API token</option>
            <option value="none">No authentication</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="wf-connector-scopes">Scopes (optional)</Label>
          <Input
            id="wf-connector-scopes"
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            Narrowing scopes is the strongest control there is — a token issued
            for <code className="font-mono">read</code> can’t reach a write API.
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="wf-connector-note">Note (optional)</Label>
        <Input
          id="wf-connector-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What this server is for, or who owns the account"
        />
      </div>
      {willDisconnect ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Changing the server URL or authentication drops the stored credential.
          You’ll need to connect again after saving.
        </p>
      ) : null}
      {save.error ? (
        <p className="text-xs text-red-600">{save.error.message}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {editing ? 'Save changes' : 'Add connector'}
        </Button>
      </div>
    </form>
  )
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
}
