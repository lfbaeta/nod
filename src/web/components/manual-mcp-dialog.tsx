import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link2 } from './icons';
import { api, errorMessage } from '../lib/api';
import { searchApps } from '../lib/app-search';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Notice,
  SearchField,
} from './ui';

type Suggestion = {
  slug: string;
  name: string;
  description: string;
  endpoint: string;
  category: string;
};

const listedKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function ManualMcpDialog({
  listed,
  onClose,
  onCreated,
  returnFocus,
}: {
  listed: { name: string; slug: string }[];
  onClose(): void;
  onCreated(id: string): void;
  returnFocus(): HTMLElement | null;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [auth, setAuth] = useState('oauth');
  const [clientIdRequired, setClientIdRequired] = useState(false);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [offered, setOffered] = useState<Suggestion[]>([]);
  const [query, setQuery] = useState('');
  const request = useRef<AbortController | null>(null);
  const continuing = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    const taken = new Set(listed.flatMap((app) => [listedKey(app.name), listedKey(app.slug)]));
    api<{ servers: Omit<Suggestion, 'category'>[] }>('/api/apps/mcp/registry', {
      signal: controller.signal,
    })
      .then((result) =>
        setOffered(
          result.servers
            .filter((item) => !taken.has(listedKey(item.name)) && !taken.has(listedKey(item.slug)))
            .map((item) => ({ ...item, category: '' })),
        ),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const matches = query.trim() ? searchApps(offered, query).slice(0, 20) : [];

  function choose(pick: Suggestion) {
    setName(pick.name);
    setEndpoint(pick.endpoint);
    setAuth('oauth');
    setClientIdRequired(false);
    setQuery('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const values = new FormData(event.currentTarget);
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ id: string }>('/api/apps/mcp', {
        method: 'POST',
        body: JSON.stringify({
          ...Object.fromEntries(values),
          ...(auth === 'oauth' && clientIdRequired ? { clientIdRequired: true } : {}),
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      continuing.current = true;
      onCreated(result.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="app-discovery-dialog"
        aria-busy={saving}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!continuing.current) returnFocus()?.focus({ preventScroll: true });
        }}
      >
        <div className="app-discovery-heading">
          <span className="app-discovery-logo">
            <Link2 size={24} aria-hidden="true" />
          </span>
          <div>
            <DialogTitle>Connect an MCP server</DialogTitle>
            <DialogDescription>Add a server to use its tools in Nod.</DialogDescription>
          </div>
        </div>
        {offered.length > 0 && (
          <div className="mcp-suggestions">
            <SearchField
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && matches[0]) {
                  event.preventDefault();
                  choose(matches[0]);
                }
              }}
              onClear={() => setQuery('')}
              placeholder={`Search ${offered.length} servers from the n8n catalog`}
              aria-label="Search suggested servers"
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
            />
            {query.trim() && (
              <div className="mcp-suggestion-list" role="listbox" aria-label="Suggested servers">
                {matches.length === 0 && <p>No server matches “{query.trim()}”.</p>}
                {matches.map((item) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    key={item.slug}
                    onClick={() => choose(item)}
                    disabled={saving}
                  >
                    <strong>{item.name}</strong>
                    {item.description && <span>{item.description}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <form onSubmit={(event) => void submit(event)} autoComplete="off">
          <Field label="Name">
            <Input
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My workspace"
              required
              minLength={2}
              maxLength={80}
              pattern="[A-Za-z0-9][A-Za-z0-9 .&amp;'_\-]{1,79}"
              disabled={saving}
            />
          </Field>
          <Field label="Server URL">
            <Input
              name="endpoint"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://example.com/mcp"
              required
              maxLength={2048}
              spellCheck={false}
              disabled={saving}
            />
          </Field>
          <Field label="Authentication">
            <select
              className="input"
              name="auth"
              value={auth}
              onChange={(event) => setAuth(event.target.value)}
              disabled={saving}
            >
              <option value="oauth">Sign in through your browser</option>
              <option value="bearer">Access token</option>
              <option value="x-api-key">API key</option>
            </select>
          </Field>
          {auth === 'oauth' && (
            <label className="app-discovery-client">
              <Checkbox
                checked={clientIdRequired}
                onChange={(event) => setClientIdRequired(event.target.checked)}
                disabled={saving}
              />
              <span>This server requires a client ID</span>
            </label>
          )}
          {error && <Notice>{error}</Notice>}
          <Button type="submit" disabled={saving}>
            {saving ? 'Checking server…' : 'Continue'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
