import { useState } from 'react'

import type { ConnectorSummary } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useSaveConnector } from '../hooks-connectors'

// Adding or editing a connector — one form for both; the fields are the same.
//
// There is no id field. The id is internal and permanent (it is embedded in
// every one of this server's tool ids, which get frozen into published agent
// configs), and nothing a human could type beats the label's slug — so the
// server derives it on create and an edit carries the existing one through.

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
        id: connector?.id,
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
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Linear"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="wf-connector-url">Server URL</Label>
          <Input
            id="wf-connector-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.linear.app/mcp"
            required
          />
        </div>
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
