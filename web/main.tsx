import React, { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import familyIcon from "./icon.svg";

type Person = { id: string; matrix_id: string; display_name: string };
type Agent = {
  id: string;
  person_id: string;
  matrix_id: string;
  display_name: string;
  avatar: string | null;
  instructions: string;
  status: "Running" | "Stopped" | "Error";
  error?: string | null;
  version: number;
};
type Settings = {
  version: number;
  runtime: "pi" | "codex";
  homeserver: string;
  provider: string;
  model: string;
  thinking_level: string;
};
type Model = {
  provider: string;
  id: string;
  name: string;
  thinking_levels: string[];
  available: boolean;
};
type Provider = {
  id: string;
  name: string;
  authenticated: boolean;
  auth_type?: string;
  auth_version: string;
  api_key?: boolean;
  auth_label?: string;
  oauth: boolean;
};
type OAuth = {
  id?: string;
  status: string;
  url?: string;
  instructions?: string;
  prompt?: string;
  prompt_type?: string;
  options?: { id: string; label: string; description?: string }[];
  error?: string;
};
type Avatar = { data: string; mime_type: string };
type RuntimeDefaults = Pick<Settings, "provider" | "model" | "thinking_level">;
type CodexAuthMethod = "siwc" | "codex" | "apiKey";
type CodexIdentity = { type: string; email?: string | null; planType?: string };
type CodexAccount = {
  version: string;
  authenticated: boolean;
  auth_method?: CodexAuthMethod | null;
  selected_auth_method?: CodexAuthMethod;
  connections?: Partial<Record<CodexAuthMethod, { configured: boolean; account?: CodexIdentity | null }>>;
  can_reauthorize?: boolean;
  registrations?: { id: string; clientId?: string; email?: string; active?: boolean; selected?: boolean }[];
  account: CodexIdentity | null;
  login?: {
    status: "pending" | "complete" | "error" | "cancelled";
    loginId?: string;
    method?: CodexAuthMethod;
    type?: "chatgpt" | "chatgptDeviceCode";
    prompt?: "callback_url";
    authUrl?: string;
    verificationUrl?: string;
    userCode?: string;
    redirectUri?: string;
    error?: string;
  };
};

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      response.status === 409
        ? "This item changed in another browser. Reload the latest version before saving. Your edits are still here."
        : (typeof value.error === "string"
            ? value.error
            : value.error?.message) ||
          value.message ||
          `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
const mxidPattern = "^@[^:\\s]+:[^\\s]+$";
const modelKey = (model: { provider: string; id?: string; model?: string }) =>
  JSON.stringify([model.provider, model.id ?? model.model]);
const levelLabel = (level: string) =>
  level === "xhigh"
    ? "Extra High"
    : level.charAt(0).toUpperCase() + level.slice(1);

function Arrow() {
  return <span aria-hidden="true">›</span>;
}
function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}
function Status({ agent }: { agent: Agent }) {
  return (
    <span className={`status ${agent.status.toLowerCase()}`}>
      <span />
      {agent.status}
    </span>
  );
}
function AvatarIcon({ agent }: { agent?: Agent }) {
  return agent?.avatar ? (
    <img className="avatar" src={agent.avatar} alt="" />
  ) : (
    <span className="avatar avatar-fallback" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3v3m-6 7h.01M18 13h.01M8 17h8M5 8h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="dialog-body">
        <div className="section-heading">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function AddPerson({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (person: Person) => void;
}) {
  const [matrixId, setMatrixId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAdded(
        await api<Person>("/people", "POST", { matrix_id: matrixId.trim() }),
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add Person"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <label>
          Matrix ID
          <input
            autoFocus
            required
            pattern={mxidPattern}
            title="Enter a full Matrix ID, such as @jack:example.org."
            placeholder="@username:example.org"
            value={matrixId}
            onChange={(event) => setMatrixId(event.target.value)}
          />
        </label>
        <p className="hint">Their display name will be fetched from Matrix.</p>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button disabled={busy}>{busy ? "Adding…" : "Add Person"}</button>
        </div>
      </form>
    </Modal>
  );
}

function AgentEditor({
  agent: initialAgent,
  personId,
  onClose,
  onChanged,
}: {
  agent: Agent | null;
  personId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [agent, setAgent] = useState(initialAgent);
  const [matrixId, setMatrixId] = useState(initialAgent?.matrix_id ?? "");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(
    initialAgent?.display_name ?? "",
  );
  const [instructions, setInstructions] = useState(
    initialAgent?.instructions ?? "",
  );
  const [avatar, setAvatar] = useState<Avatar | null>();
  const [preview, setPreview] = useState(initialAgent?.avatar ?? "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  function failed(error: unknown) {
    setError(errorText(error));
    setConflict(error instanceof ApiError && error.status === 409);
  }
  async function upload(file?: File) {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        file.type,
      )
    ) {
      setError("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Choose an image smaller than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result);
      setAvatar({
        data: data.slice(data.indexOf(",") + 1),
        mime_type: file.type,
      });
      setPreview(data);
      setError("");
    };
    reader.onerror = () =>
      setError("The image could not be read. Please try another file.");
    reader.readAsDataURL(file);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError("");
    setConflict(false);
    try {
      const body = {
        person_id: personId,
        matrix_id: matrixId.trim(),
        password,
        display_name: displayName.trim(),
        instructions,
        ...(avatar !== undefined ? { avatar } : {}),
        ...(agent ? { version: agent.version } : {}),
      };
      await api<Agent>(
        agent ? `/agents/${agent.id}` : "/agents",
        agent ? "PUT" : "POST",
        body,
      );
      onChanged();
      onClose();
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  async function lifecycle(action: string) {
    if (!agent) return;
    setBusy(action);
    setError("");
    setConflict(false);
    try {
      const updated = await api<Agent>(
        `/agents/${agent.id}/${action}`,
        "POST",
        { version: agent.version },
      );
      setAgent(updated);
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  async function reloadVersion() {
    if (!agent) return;
    setBusy("reload");
    try {
      const agents = await api<Agent[]>(
        `/agents?person_id=${encodeURIComponent(personId)}`,
      );
      const current = agents.find((item) => item.id === agent.id);
      if (!current) {
        setError("This Agent was deleted in another browser.");
        return;
      }
      setAgent(current);
      setConflict(false);
      setError("Latest version loaded. Review your edits before saving.");
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    if (!agent) return;
    setBusy("delete");
    setError("");
    try {
      await api(`/agents/${agent.id}`, "DELETE", { version: agent.version });
      onChanged();
      onClose();
    } catch (error) {
      failed(error);
      setConfirmDelete(false);
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal
      title={agent ? "Agent Details" : "Add Agent"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {agent && (
        <div className="agent-runtime">
          <Status agent={agent} />
          <div className="lifecycle">
            <button
              className="small secondary"
              type="button"
              disabled={!!busy || agent.status === "Running"}
              onClick={() => void lifecycle("start")}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </button>
            <button
              className="small secondary"
              type="button"
              disabled={!!busy || agent.status === "Stopped"}
              onClick={() => void lifecycle("stop")}
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
            <button
              className="small secondary"
              type="button"
              disabled={!!busy}
              onClick={() => void lifecycle("restart")}
            >
              {busy === "restart" ? "Restarting…" : "Restart"}
            </button>
          </div>
        </div>
      )}
      {agent?.error && <Alert>{agent.error}</Alert>}
      <form onSubmit={submit}>
        <label>
          Matrix ID
          <input
            required
            autoFocus={!agent}
            pattern={mxidPattern}
            title="Enter a full Matrix ID, such as @assistant:example.org."
            value={matrixId}
            onChange={(event) => setMatrixId(event.target.value)}
            placeholder="@assistant:example.org"
            autoComplete="off"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required={!agent}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={
              agent ? "Leave blank to keep password" : "Matrix account password"
            }
          />
        </label>
        <label>
          Display Name
          <input
            required
            maxLength={256}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="My Assistant"
          />
        </label>
        <label>
          Avatar <span className="optional">optional</span>
          <span className="image-upload">
            {preview ? (
              <img className="avatar" src={preview} alt="Avatar preview" />
            ) : (
              <AvatarIcon />
            )}
            <span className="upload-control">
              Upload Image
              <input
                type="file"
                aria-label="Avatar"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => void upload(event.target.files?.[0])}
              />
            </span>
            {preview && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setAvatar(null);
                  setPreview("");
                }}
              >
                Remove Image
              </button>
            )}
          </span>
        </label>
        <label>
          Instructions <span className="optional">optional</span>
          <textarea
            rows={5}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="You are a helpful assistant…"
          />
        </label>
        {error && (
          <Alert>
            {error}
            {conflict && (
              <button
                className="text-button"
                type="button"
                disabled={!!busy}
                onClick={() => void reloadVersion()}
              >
                Load Latest Version
              </button>
            )}
          </Alert>
        )}
        <div className="actions">
          <button
            className="secondary"
            type="button"
            disabled={!!busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button disabled={!!busy}>
            {busy === "save"
              ? "Saving…"
              : agent
                ? "Save Changes"
                : "Create Agent"}
          </button>
        </div>
      </form>
      {agent && (
        <div className="delete-area">
          {confirmDelete ? (
            <div className="delete-confirm">
              <p>
                Delete <strong>{agent.display_name}</strong>? This stops the
                Agent and removes its local configuration.
              </p>
              <div className="actions">
                <button
                  className="secondary small"
                  disabled={!!busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button
                  className="danger small"
                  disabled={!!busy}
                  onClick={() => void remove()}
                >
                  {busy === "delete" ? "Deleting…" : "Delete Agent"}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="text-button danger-text"
              disabled={!!busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete Agent
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

function ProviderAuth({
  provider,
  onChanged,
}: {
  provider: Provider;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  function failed(error: unknown) {
    setError(errorText(error));
    setStale(error instanceof ApiError && error.status === 409);
  }
  const [oauth, setOauth] = useState<OAuth | null>(null);
  const [input, setInput] = useState("");
  const oauthId = useRef("");
  useEffect(
    () => () => {
      if (oauthId.current)
        void api(
          `/oauth/${encodeURIComponent(oauthId.current)}`,
          "DELETE",
        ).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!oauthId.current) return;
    const timer = window.setInterval(() => {
      void api<OAuth>(`/oauth/${encodeURIComponent(oauthId.current)}`)
        .then((next) => {
          setOauth(next);
          if (
            [
              "complete",
              "success",
              "authenticated",
              "error",
              "cancelled",
            ].includes(next.status)
          ) {
            window.clearInterval(timer);
            if (
              ["complete", "success", "authenticated"].includes(next.status)
            ) {
              oauthId.current = "";
              setOauth(null);
              onChanged();
            }
          }
        })
        .catch((error) => {
          failed(error);
          window.clearInterval(timer);
        });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [oauth?.id]);
  async function removeKey() {
    setBusy("remove");
    setError("");
    try {
      await api(`/providers/${encodeURIComponent(provider.id)}/key`, "DELETE", {
        version: provider.auth_version,
      });
      onChanged();
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  async function signIn(type: "oauth" | "api_key" = "oauth") {
    setBusy("oauth");
    setError("");
    try {
      const flow = await api<OAuth & { id: string }>(
        `/providers/${encodeURIComponent(provider.id)}/oauth`,
        "POST",
        { type, version: provider.auth_version },
      );
      oauthId.current = flow.id;
      setOauth(flow);
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  async function respond(event: React.FormEvent) {
    event.preventDefault();
    setBusy("input");
    setError("");
    try {
      await api(`/oauth/${encodeURIComponent(oauthId.current)}`, "POST", {
        input,
      });
      setInput("");
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  async function cancelOAuth() {
    setBusy("cancel");
    try {
      await api(`/oauth/${encodeURIComponent(oauthId.current)}`, "DELETE");
      setOauth(null);
      oauthId.current = "";
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }
  return (
    <article className="provider-card">
      <div className="provider-heading">
        <div>
          <h3>{provider.name || provider.id}</h3>
          <p className="hint">{provider.id}</p>
        </div>
        <span
          className={`auth-status ${provider.authenticated ? "connected" : ""}`}
        >
          {provider.authenticated
            ? `Connected${provider.auth_type === "api_key" ? " · API key" : provider.auth_type === "oauth" ? " · Signed in" : ""}`
            : "Not configured"}
        </span>
      </div>
      <div className="provider-actions">
        {provider.api_key !== false && (
          <button
            className="small secondary"
            disabled={!!busy || !!oauth}
            onClick={() => void signIn("api_key")}
          >
            Configure Provider
          </button>
        )}
        {provider.oauth && (
          <button
            className="small secondary"
            disabled={!!busy || !!oauth}
            onClick={() => void signIn()}
          >
            {busy === "oauth" ? "Connecting…" : "Sign In"}
          </button>
        )}
        {provider.authenticated && (
          <button
            className="small text-button"
            disabled={!!busy || !!oauth}
            onClick={() => void removeKey()}
          >
            Disconnect
          </button>
        )}
      </div>
      {oauth && (
        <div className="oauth-flow">
          <p>
            {oauth.instructions ||
              "Complete the provider configuration to continue."}
          </p>
          {oauth.url && /^https?:\/\//i.test(oauth.url) && (
            <a
              className="button small"
              href={oauth.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Sign In ↗
            </a>
          )}
          {oauth.prompt && (
            <form onSubmit={respond}>
              <label>
                {oauth.prompt}
                {oauth.options?.length ? (
                  <select
                    required
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose an option
                    </option>
                    {oauth.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                        {option.description ? ` — ${option.description}` : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    required
                    type={oauth.prompt_type === "secret" ? "password" : "text"}
                    value={input}
                    autoComplete="off"
                    onChange={(event) => setInput(event.target.value)}
                  />
                )}
              </label>
              <button className="small" disabled={!!busy}>
                Continue
              </button>
            </form>
          )}
          {oauth.error && <Alert>{oauth.error}</Alert>}
          <button
            className="text-button small"
            disabled={!!busy}
            onClick={() => void cancelOAuth()}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <Alert>
          {error}
          {stale && (
            <button
              className="text-button"
              onClick={() => {
                onChanged();
                setStale(false);
                setError(
                  "Latest provider status loaded. Review and try again.",
                );
              }}
            >
              Load Latest Status
            </button>
          )}
        </Alert>
      )}
    </article>
  );
}

function Providers({
  onBack,
  onChanged,
}: {
  onBack: () => void;
  onChanged: () => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [json, setJson] = useState("");
  const [version, setVersion] = useState<string | number>("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [conflict, setConflict] = useState(false);
  const [custom, setCustom] = useState({
    id: "",
    baseUrl: "",
    api: "openai-completions",
    model: "",
  });
  async function loadProviders() {
    try {
      setProviders(await api<Provider[]>("/providers"));
      setCatalogError("");
    } catch (error) {
      setCatalogError(errorText(error));
    }
  }
  async function loadConfig() {
    setLoading(true);
    try {
      const result = await api<{ version: string | number; config: unknown }>(
        "/providers/config",
      );
      setVersion(result.version);
      setJson(JSON.stringify(result.config, null, 2));
      setConflict(false);
      setError("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadProviders();
    void loadConfig();
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let config: unknown;
      try {
        config = JSON.parse(json);
      } catch {
        throw new Error(
          "The configuration is not valid JSON. Check its syntax and try again.",
        );
      }
      const result = await api<{ version: string | number; config: unknown }>(
        "/providers/config",
        "PUT",
        { version, config },
      );
      setVersion(result.version);
      setJson(JSON.stringify(result.config, null, 2));
      setNotice("Provider configuration saved.");
      setConflict(false);
      void loadProviders();
      onChanged();
    } catch (error) {
      setError(errorText(error));
      setConflict(error instanceof ApiError && error.status === 409);
    } finally {
      setBusy(false);
    }
  }
  function addCustom(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      const config = JSON.parse(json);
      config.providers ??= {};
      if (config.providers[custom.id])
        throw new Error(
          "That provider already exists. Edit its native JSON configuration below.",
        );
      config.providers[custom.id] = {
        baseUrl: custom.baseUrl.trim(),
        api: custom.api,
        models: [{ id: custom.model.trim() }],
      };
      setJson(JSON.stringify(config, null, 2));
      setCustom({ id: "", baseUrl: "", api: "openai-completions", model: "" });
      setNotice(
        "Custom provider added to the editor. Save this configuration, then use Configure Provider above.",
      );
    } catch (error) {
      setError(errorText(error));
    }
  }
  function authChanged() {
    void loadProviders();
    onChanged();
  }
  return (
    <>
      <button className="back-button" onClick={onBack}>
        ‹ Settings
      </button>
      <div className="page-heading">
        <h1>Providers</h1>
        <p>Connect a provider or configure custom models.</p>
      </div>
      <section className="panel">
        <label className="search-label">
          Find a Provider
          <input
            type="search"
            placeholder="Search providers…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {catalogError && <Alert>{catalogError}</Alert>}
        <div className="provider-list">
          {providers
            .filter((provider) =>
              `${provider.id} ${provider.name}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((provider) => (
              <ProviderAuth
                key={provider.id}
                provider={provider}
                onChanged={authChanged}
              />
            ))}
          {providers.length === 0 && !loading && (
            <p className="hint">No providers are available yet.</p>
          )}
        </div>
      </section>
      <section className="panel">
        <details className="provider-advanced">
          <summary>Advanced Provider Configuration</summary>
          <p className="hint">
            For custom endpoints or model settings. Connect official providers
            using Configure Provider or Sign In above.
          </p>
          <details>
            <summary>Add a Custom Provider</summary>
            <form className="custom-provider" onSubmit={addCustom}>
              <label>
                Provider ID
                <input
                  required
                  pattern="[A-Za-z0-9_.-]+"
                  value={custom.id}
                  placeholder="my-provider"
                  onChange={(event) =>
                    setCustom({ ...custom, id: event.target.value })
                  }
                />
              </label>
              <label>
                Base URL
                <input
                  required
                  type="url"
                  value={custom.baseUrl}
                  placeholder="https://api.example.org/v1"
                  onChange={(event) =>
                    setCustom({ ...custom, baseUrl: event.target.value })
                  }
                />
              </label>
              <label>
                API
                <input
                  list="api-types"
                  required
                  value={custom.api}
                  onChange={(event) =>
                    setCustom({ ...custom, api: event.target.value })
                  }
                />
                <datalist id="api-types">
                  <option value="openai-completions" />
                  <option value="openai-responses" />
                  <option value="anthropic-messages" />
                  <option value="google-generative-ai" />
                </datalist>
              </label>
              <label>
                Model ID
                <input
                  required
                  value={custom.model}
                  placeholder="model-name"
                  onChange={(event) =>
                    setCustom({ ...custom, model: event.target.value })
                  }
                />
              </label>
              <button className="small secondary" disabled={loading}>
                Add to Configuration
              </button>
            </form>
          </details>
          <form onSubmit={save}>
            <label>
              Configuration JSON
              <textarea
                className="json-editor"
                aria-label="Configuration JSON"
                spellCheck={false}
                rows={19}
                value={json}
                onChange={(event) => setJson(event.target.value)}
                disabled={loading}
                aria-describedby="native-config-help"
              />
            </label>
            <p id="native-config-help" className="hint">
              This editor supports all provider and model settings. Saved
              credentials are hidden; keep their placeholders unchanged.{" "}
              <a
                href="/api/providers/schema"
                target="_blank"
                rel="noopener noreferrer"
              >
                Configuration Reference ↗
              </a>
            </p>
            {error && (
              <Alert>
                {error}
                {conflict && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Load the latest configuration? This replaces the JSON currently in the editor.",
                        )
                      )
                        void loadConfig();
                    }}
                  >
                    Reload Configuration
                  </button>
                )}
              </Alert>
            )}
            {notice && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
            <div className="actions">
              <button disabled={busy || loading}>
                {busy ? "Saving…" : "Save Provider Configuration"}
              </button>
            </div>
          </form>
        </details>
      </section>
    </>
  );
}

function CodexAuthentication({ onChanged, disabled }: {
  onChanged: () => void;
  disabled: boolean;
}) {
  const [account, setAccount] = useState<CodexAccount | null>(null);
  const [method, setMethod] = useState<CodexAuthMethod | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [planNotice, setPlanNotice] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{
    loginId: string;
    method: CodexAuthMethod;
    url?: string;
    verificationUrl?: string;
    userCode?: string;
    redirectUri?: string;
  } | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  function signInError(error: unknown) {
    const message = typeof error === "string" ? error : errorText(error);
    return /[?&](?:code|state|client_id)=/.test(message)
      ? "Sign in could not be completed. Start sign in again."
      : message;
  }
  async function refresh() {
    const current = ++request.current;
    try {
      const next = await api<CodexAccount>("/codex/account");
      if (!alive.current || current !== request.current) return;
      setAccount(next);
      setMethod((selected) => selected || (next.login?.status === "pending" ? next.login.method : undefined) || next.selected_auth_method || next.auth_method || "siwc");
      if (next.authenticated && next.auth_method === "siwc" && !localStorage.getItem("family-agents.chatgpt-plan-notice"))
        setPlanNotice(true);
      setRegistrationId((selected) => selected && (selected === "new" || next.registrations?.some((item) => item.id === selected))
        ? selected : next.registrations?.find((item) => item.selected || item.active)?.id || next.registrations?.[0]?.id || "");
      if (next.login?.status === "error") setError(signInError(next.login.error || "Sign in failed. Try again."));
      if (next.login?.status === "complete" && account?.login?.status === "pending") setError("");
      if (next.login?.status === "pending" && next.login.loginId) {
        const login = next.login;
        setPending((previous) => ({
          loginId: login.loginId!,
          method: login.method || (login.prompt === "callback_url" ? "siwc" : "codex"),
          url: login.authUrl || (previous?.loginId === login.loginId ? previous?.url : undefined),
          verificationUrl: login.verificationUrl || (previous?.loginId === login.loginId ? previous?.verificationUrl : undefined),
          userCode: login.userCode || (previous?.loginId === login.loginId ? previous?.userCode : undefined),
          redirectUri: login.redirectUri || (previous?.loginId === login.loginId ? previous?.redirectUri : undefined),
        }));
      } else setPending(null);
      if (next.authenticated && next.login?.status !== "pending") changed.current();
    } catch (error) {
      if (alive.current && current === request.current) setError(signInError(error));
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; request.current++; };
  }, []);
  useEffect(() => { setCallbackUrl(""); }, [pending?.loginId]);
  useEffect(() => {
    if ((!pending && account?.login?.status !== "pending") || busy) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [pending, account?.login?.status, busy]);

  async function authenticate(type: "apiKey" | "chatgpt" | "codex" | "codexDeviceCode") {
    if (!account || busy) return;
    if (type === "apiKey" && !apiKey.trim()) {
      setError("Enter an API key.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setCallbackUrl("");
    try {
      const result = await api<{
        type: string;
        loginId?: string;
        method?: CodexAuthMethod;
        authUrl?: string;
        verificationUrl?: string;
        userCode?: string;
        redirectUri?: string;
      }>("/codex/login", "POST", {
        type,
        version: account.version,
        ...(type === "apiKey" ? { apiKey } : type === "chatgpt" ? {
          newAccount: registrationId === "new",
          ...(registrationId && registrationId !== "new" ? { registrationId } : {}),
        } : {}),
      });
      if (!alive.current) return;
      setApiKey("");
      if (result.loginId)
        setPending({ loginId: result.loginId, method: result.method || (type === "chatgpt" ? "siwc" : "codex"), url: result.authUrl, verificationUrl: result.verificationUrl, userCode: result.userCode, redirectUri: result.redirectUri });
      await refresh();
    } catch (error) {
      if (alive.current) {
        setError(signInError(error));
        if (error instanceof ApiError && error.status === 409) void refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function useConnection() {
    if (!account || !method || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/codex/auth-method", "POST", { method, version: account.version });
      if (!alive.current) return;
      await refresh();
      setNotice("Active connection updated.");
      changed.current();
    } catch (error) {
      if (alive.current) {
        setError(signInError(error));
        if (error instanceof ApiError && error.status === 409) void refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function completeSignIn() {
    if (!account || !pending || pending.method !== "siwc" || busy || !callbackUrl.trim()) return;
    const address = callbackUrl.trim();
    setCallbackUrl("");
    setBusy(true);
    setError("");
    try {
      await api("/codex/login/callback", "POST", {
        loginId: pending.loginId,
        callbackUrl: address,
        version: account.version,
      });
      if (!alive.current) return;
      await refresh();
      changed.current();
    } catch (error) {
      if (alive.current) {
        setError(error instanceof ApiError && error.status === 409
          ? "Sign in changed in another browser. Refresh the status before continuing."
          : "Sign in could not be completed. Check the complete address from your browser, or cancel and start again.");
        void refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function endAuthentication(cancel: boolean) {
    if (!account || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setCallbackUrl("");
    try {
      const result = await api<{ warning?: string; revocationConfirmed?: boolean }>(cancel ? "/codex/login/cancel" : "/codex/account", cancel ? "POST" : "DELETE", {
        version: account.version,
        ...(pending ? { loginId: pending.loginId } : {}),
      });
      if (!alive.current) return;
      setPending(null);
      setRegistrationId("");
      setPlanNotice(false);
      if (!cancel && result.revocationConfirmed === false)
        setNotice(result.warning || "Signed out locally. Review this app’s access in ChatGPT settings because revocation could not be confirmed.");
      await refresh();
      changed.current();
    } catch (error) {
      if (alive.current) {
        setError(signInError(error));
        if (error instanceof ApiError && error.status === 409) void refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function safeLoginUrl(address?: string) {
    try {
      const url = new URL(address || "");
      if (url.protocol === "https:" && url.hostname === "auth.openai.com" && !url.username && !url.password) return url.href;
    } catch {}
    return undefined;
  }
  const loginUrl = safeLoginUrl(pending?.url);
  const verificationUrl = safeLoginUrl(pending?.verificationUrl);
  const waiting = !!pending || account?.login?.status === "pending";
  const locked = busy || disabled || !account;
  const activeMethod = account?.auth_method;
  const selectedMethod = method || "siwc";
  const methodLabels: Record<CodexAuthMethod, string> = {
    siwc: "Sign in with ChatGPT (New)",
    codex: "Codex Native Login",
    apiKey: "API Key",
  };
  const selectedConnection = account?.connections?.[selectedMethod];
  const selectedIsActive = account?.authenticated && activeMethod === selectedMethod;
  return (
    <section className="panel">
      <h2>Codex Authentication</h2>
      <p role="status">
        {account ? account.authenticated
          ? `Active connection: ${activeMethod ? methodLabels[activeMethod] : "ChatGPT"}${account.account?.email ? ` — ${account.account.email}` : ""}${account.account?.planType ? ` (${account.account.planType})` : ""}.`
          : "Not signed in." : error ? "Codex is unavailable." : "Checking Codex authentication…"}
      </p>
      {account?.authenticated && account.auth_method === "siwc" && <p className="hint">Using your ChatGPT plan. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>.</p>}
      <div className="provider-actions">
        <button type="button" className="secondary small" disabled={busy || disabled} onClick={() => { setError(""); void refresh(); }}>Refresh Status</button>
        {account?.authenticated && <button type="button" className="text-button" disabled={locked || waiting} onClick={() => void endAuthentication(false)}>Sign Out</button>}
      </div>
      <label htmlFor="codex-auth-method">Connection Method</label>
      <select id="codex-auth-method" value={selectedMethod} disabled={locked || waiting} onChange={(event) => {
        setMethod(event.target.value as CodexAuthMethod);
        setApiKey("");
        setCallbackUrl("");
        setError("");
        setNotice("");
      }}>
        {Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {waiting ? (
        <div className="oauth-flow">
          <p role="status">Complete {methodLabels[pending?.method || selectedMethod]} in the browser. This page updates automatically.</p>
          {pending?.userCode ? <>
            <p>Enter this code: <strong>{pending.userCode}</strong></p>
            {verificationUrl && <a className="button" href={verificationUrl} target="_blank" rel="noreferrer">Open Device Sign In</a>}
          </> : loginUrl && <a className="button" href={loginUrl} target="_blank" rel="noreferrer">Open ChatGPT Sign In</a>}
          {pending?.method === "siwc" && <>
            <p className="hint">If the final browser page cannot open, copy its full address and paste it below. This also works when your browser is on another computer.</p>
            <label>
              Final Browser URL
              <input type="text" autoComplete="off" autoCapitalize="off" spellCheck={false}
                value={callbackUrl} disabled={locked}
                placeholder={pending.redirectUri || "Paste the complete final browser address"}
                onChange={(event) => setCallbackUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void completeSignIn(); } }} />
            </label>
          </>}
          {pending?.method === "codex" && !pending.userCode && <p className="hint">Finish in a browser on the service computer. For a browser on another computer, cancel and use Sign In with Device Code.</p>}
          <div className="provider-actions">
            {pending?.method === "siwc" && <button type="button" className="secondary small" disabled={locked || !callbackUrl.trim()} onClick={() => void completeSignIn()}>Complete Sign In</button>}
            <button type="button" className="text-button" disabled={locked} onClick={() => void endAuthentication(true)}>Cancel Sign In</button>
          </div>
        </div>
      ) : (
        <>
          {selectedConnection?.configured && <>
            <p className="hint">{selectedIsActive ? "This connection is active." : `Saved connection${selectedConnection.account?.email ? `: ${selectedConnection.account.email}` : ""}. Choose Use Connection to activate it.`}</p>
            {!selectedIsActive && <div className="provider-actions">
              <button type="button" className="secondary small" disabled={locked} onClick={() => void useConnection()}>Use Connection</button>
            </div>}
          </>}
          {selectedMethod === "siwc" && <>
            {!!account?.registrations?.length && <>
              <label htmlFor="codex-chatgpt-account">ChatGPT Account</label>
              <select id="codex-chatgpt-account" value={registrationId} disabled={locked} onChange={(event) => setRegistrationId(event.target.value)}>
                {account.registrations.map((item) => <option key={item.id} value={item.id}>
                  {item.email || "Saved ChatGPT account"}{account.registrations!.filter((other) => other.email === item.email).length > 1 ? ` (${(item.clientId || item.id).slice(-8)})` : ""}{account.authenticated && account.auth_method === "siwc" && (item.selected || item.active) ? " (connected)" : ""}
                </option>)}
                <option value="new">Another ChatGPT account or workspace</option>
              </select>
            </>}
            <div className="provider-actions">
              <button type="button" className="secondary small" data-oai-siwc-button="" disabled={locked} onClick={() => void authenticate("chatgpt")}>Continue with ChatGPT</button>
            </div>
            <p className="hint">Use your ChatGPT plan for conversations, calculations, time and timezone tools, and attached documents. This connection does not grant access to your ChatGPT conversations. Native web search is currently unavailable with this connection, and image generation is not supported. Use Codex Native Login for those features when your account permits them.</p>
          </>}
          {selectedMethod === "codex" && <>
            <div className="provider-actions">
              <button type="button" className="secondary small" disabled={locked} onClick={() => void authenticate("codexDeviceCode")}>Sign In with Device Code</button>
              <button type="button" className="text-button" disabled={locked} onClick={() => void authenticate("codex")}>Sign In in Browser</button>
            </div>
            <p className="hint">Use device code when your browser is on another computer. This connection supports live search, public webpages, weather, market data, and image generation when your model and account permit them. Calculations and time tools are also available.</p>
          </>}
          {selectedMethod === "apiKey" && <>
            <label className="codex-key">
              API Key
              <input type="password" autoComplete="off" value={apiKey} disabled={locked}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void authenticate("apiKey"); } }}
                placeholder="Enter an OpenAI API key" />
            </label>
            <div className="provider-actions">
              <button type="button" className="secondary small" disabled={locked || !apiKey.trim()} onClick={() => void authenticate("apiKey")}>Save API Key</button>
            </div>
          </>}
        </>
      )}
      {planNotice && account?.authenticated && account.auth_method === "siwc" && <div className="oauth-flow">
        <p>You’re using your ChatGPT plan.</p>
        <p className="hint">You can review and manage this app’s usage in <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">ChatGPT usage settings</a>.</p>
        <button type="button" className="secondary small" onClick={() => {
          localStorage.setItem("family-agents.chatgpt-plan-notice", "dismissed");
          setPlanNotice(false);
        }}>Got it</button>
      </div>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {error && <Alert>{error}</Alert>}
    </section>
  );
}

function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [providers, setProviders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [changingRuntime, setChangingRuntime] = useState(false);
  const selection = useRef(0);
  const runtimeRequest = useRef(0);
  const modelRequest = useRef(0);
  const currentRuntime = useRef<Settings["runtime"]>("pi");
  const drafts = useRef<Partial<Record<Settings["runtime"], RuntimeDefaults>>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  async function loadModels(runtime = currentRuntime.current) {
    if (runtime !== currentRuntime.current) return;
    const request = ++modelRequest.current;
    setLoadingModels(true);
    try {
      const catalog = await api<Model[]>(`/models?runtime=${runtime}`);
      if (request === modelRequest.current && runtime === currentRuntime.current)
        setModels(catalog.filter((model) => model.available));
    } catch (error) {
      if (request === modelRequest.current) setError(errorText(error));
    } finally {
      if (request === modelRequest.current) setLoadingModels(false);
    }
  }
  async function loadSettings() {
    try {
      const next = await api<Settings>("/settings");
      currentRuntime.current = next.runtime;
      drafts.current = {};
      selection.current++;
      runtimeRequest.current++;
      setSettings(next);
      setConflict(false);
      setError("");
      await loadModels(next.runtime);
    } catch (error) {
      setError(errorText(error));
    }
  }
  useEffect(() => {
    void loadSettings();
    return () => { modelRequest.current++; runtimeRequest.current++; selection.current++; };
  }, []);
  async function chooseRuntime(runtime: Settings["runtime"]) {
    if (!settings || runtime === settings.runtime) return;
    drafts.current[settings.runtime] = { provider: settings.provider, model: settings.model, thinking_level: settings.thinking_level };
    const request = ++runtimeRequest.current;
    selection.current++;
    modelRequest.current++;
    setSelecting(false);
    setChangingRuntime(true);
    setError("");
    setNotice("");
    try {
      const defaults = drafts.current[runtime] ?? await api<RuntimeDefaults>(`/runtime-defaults?runtime=${runtime}`);
      if (request !== runtimeRequest.current) return;
      currentRuntime.current = runtime;
      setModels([]);
      setSettings((current) => current ? { ...current, ...defaults, runtime } : current);
      await loadModels(runtime);
    } catch (error) {
      if (request === runtimeRequest.current) setError(errorText(error));
    } finally {
      if (request === runtimeRequest.current) setChangingRuntime(false);
    }
  }
  async function chooseModel(value: string) {
    if (!settings) return;
    const [provider, model] = JSON.parse(value) as [string, string];
    const next = { ...settings, provider, model };
    const request = ++selection.current;
    setSettings(next);
    setSelecting(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{
        thinking_level: string;
        thinking_levels: string[];
      }>("/model-selection", "POST", next);
      if (selection.current === request)
        setSettings((current) =>
          current
            ? { ...current, thinking_level: result.thinking_level }
            : current,
        );
    } catch (error) {
      if (selection.current === request) setError(errorText(error));
    } finally {
      if (selection.current === request) setSelecting(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api<Settings>("/settings", "PUT", settings);
      setSettings(saved);
      drafts.current[saved.runtime] = { provider: saved.provider, model: saved.model, thinking_level: saved.thinking_level };
      setNotice(
        "Settings saved. Agents use these defaults from their next turn.",
      );
      setConflict(false);
    } catch (error) {
      setError(errorText(error));
      setConflict(error instanceof ApiError && error.status === 409);
    } finally {
      setBusy(false);
    }
  }
  if (providers)
    return (
      <Providers
        onBack={() => {
          setProviders(false);
          void loadModels("pi");
        }}
        onChanged={() => void loadModels("pi")}
      />
    );
  const selected = models.find(
    (model) =>
      model.provider === settings?.provider && model.id === settings?.model,
  );
  const levels = selected?.thinking_levels ?? [];
  return (
    <>
      <button className="back-button" onClick={onBack}>
        ‹ Family Agents
      </button>
      <div className="page-heading">
        <h1>Settings</h1>
        <p>Shared defaults for all family Agents.</p>
      </div>
      {!settings ? (
        <p role="status">{error || "Loading settings…"}</p>
      ) : (
        <form onSubmit={save} className="settings-form">
          <section className="panel">
            <h2>Matrix Server</h2>
            <label className="sr-only" htmlFor="homeserver">
              Matrix Server
            </label>
            <input
              id="homeserver"
              type="url"
              required
              placeholder="https://matrix.example.org"
              value={settings.homeserver}
              onChange={(event) =>
                setSettings({ ...settings, homeserver: event.target.value })
              }
            />
          </section>
          <section className="panel">
            <h2>Agent Runtime</h2>
            <label className="sr-only" htmlFor="agent-runtime">Agent Runtime</label>
            <select id="agent-runtime" value={settings.runtime} disabled={busy || changingRuntime}
              onChange={(event) => void chooseRuntime(event.target.value as Settings["runtime"])}>
              <option value="pi">Pi Coding Agent</option>
              <option value="codex">Codex App Server</option>
            </select>
            <p className="hint">All Agents use this runtime. Save Settings to apply the selection.</p>
          </section>
          {settings.runtime === "pi" ? (
            <section className="panel">
              <h2>Providers</h2>
              <button type="button" className="navigation-row" disabled={busy || changingRuntime} onClick={() => setProviders(true)}>
                Configure Providers
                <Arrow />
              </button>
            </section>
          ) : <CodexAuthentication onChanged={() => void loadModels("codex")} disabled={busy || changingRuntime} />}
          <section className="panel">
            <h2>Files in Matrix</h2>
            <p className="hint">Send an encrypted text, code, CSV, PDF, Word (.docx), or Excel (.xlsx) attachment to your Agent. Add a message asking for a summary, comparison, or analysis. Files can be up to 8 MiB; long documents are shortened to fit the conversation.</p>
            <p className="hint">PDFs need selectable text. Scanned pages can be sent as images for a model that supports image understanding.</p>
          </section>
          <section className="panel">
            <h2>Default Model</h2>
            <label className="sr-only" htmlFor="default-model">
              Default Model
            </label>
            <select
              id="default-model"
              required
              value={selected ? modelKey(selected) : ""}
              disabled={busy || changingRuntime || loadingModels || !models.length}
              onChange={(event) => void chooseModel(event.target.value)}
            >
              <option value="" disabled>
                {loadingModels
                  ? "Loading models…"
                  : models.length
                    ? "Select a model"
                    : settings.runtime === "codex" ? "Sign in to Codex first" : "Configure a provider first"}
              </option>
              {models.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.provider} / {model.name || model.id}
                </option>
              ))}
            </select>
            {!loadingModels && !models.length && (
              <p className="hint" role="status">
                {settings.runtime === "codex"
                  ? "No models are available yet. Check Codex authentication above and refresh the status."
                  : "No models are available yet. Configure a provider above to get started."}
              </p>
            )}
            {!loadingModels && settings.model && !selected && (
              <p className="hint" role="status">
                Saved model {settings.provider} / {settings.model} is
                unavailable. {settings.runtime === "codex" ? "Check Codex authentication or choose another available model." : "Configure its provider or choose another available model."}
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Advanced Configuration</h2>
            <label>
              Thinking Level
              <select
                disabled={!selected || selecting || busy || changingRuntime}
                value={
                  levels.includes(settings.thinking_level)
                    ? settings.thinking_level
                    : ""
                }
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    thinking_level: event.target.value,
                  })
                }
              >
                {!levels.length && (
                  <option value="">Select a model first</option>
                )}
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {levelLabel(level)}
                  </option>
                ))}
              </select>
            </label>
          </section>
          {error && (
            <Alert>
              {error}
              {conflict && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Reload saved settings? This replaces your unsaved settings.",
                      )
                    )
                      void loadSettings();
                  }}
                >
                  Reload Settings
                </button>
              )}
            </Alert>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <div className="actions">
            <button disabled={busy || selecting || changingRuntime || loadingModels || !selected}>
              {busy ? "Saving…" : "Save Settings"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function App() {
  const [people, setPeople] = useState<Person[]>([]);
  const [personId, setPersonId] = useState(
    () => localStorage.getItem("family-agents.person") || "",
  );
  const [agents, setAgents] = useState<Agent[]>([]);
  const [settings, setSettings] = useState(false);
  const [addPerson, setAddPerson] = useState(false);
  const [editor, setEditor] = useState<Agent | "new" | null>(null);
  const [error, setError] = useState("");
  const [loadingPeople, setLoadingPeople] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const personRequest = useRef(0);
  async function loadPeople() {
    try {
      const result = await api<Person[]>("/people");
      setPeople(result);
      setPersonId((current) =>
        result.some((person) => person.id === current)
          ? current
          : (result[0]?.id ?? ""),
      );
      setError("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoadingPeople(false);
    }
  }
  async function loadAgents(showLoading = false) {
    if (!personId) {
      setAgents([]);
      return;
    }
    const request = ++personRequest.current;
    if (showLoading) {
      setLoadingAgents(true);
      setAgents([]);
    }
    try {
      const result = await api<Agent[]>(
        `/agents?person_id=${encodeURIComponent(personId)}`,
      );
      if (request === personRequest.current) {
        setAgents(result);
        setError("");
      }
    } catch (error) {
      if (request === personRequest.current) setError(errorText(error));
    } finally {
      if (request === personRequest.current) setLoadingAgents(false);
    }
  }
  useEffect(() => {
    void loadPeople();
  }, []);
  useEffect(() => {
    localStorage.setItem("family-agents.person", personId);
    void loadAgents(true);
    const timer = window.setInterval(() => void loadAgents(), 5000);
    return () => {
      window.clearInterval(timer);
      personRequest.current++;
    };
  }, [personId]);
  return (
    <div className="app-shell">
      <header>
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            setSettings(false);
          }}
        >
          <img
            className="brand-mark"
            src={familyIcon}
            alt=""
            aria-hidden="true"
          />
          Family Agents
        </a>
        {!settings && (
          <button className="secondary small" onClick={() => setSettings(true)}>
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
            >
              <path
                d="m10 3-1 3-3 1-3 3 2 2-1 4 3 1 2 4h4l1-3 4-1 3-4-2-2 1-4-3-1-2-3h-5Z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle
                cx="12"
                cy="12"
                r="3"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
            Settings
          </button>
        )}
      </header>
      <main>
        {settings ? (
          <SettingsPage
            onBack={() => {
              setSettings(false);
              void loadAgents();
            }}
          />
        ) : (
          <>
            <div className="page-heading">
              <h1>Your family’s Agents</h1>
              <p>A little help, one Matrix conversation away.</p>
            </div>
            <section className="person-picker">
              <label htmlFor="person">Person</label>
              <select
                id="person"
                value={personId}
                disabled={loadingPeople}
                onChange={(event) => {
                  if (event.target.value === "__add__") setAddPerson(true);
                  else setPersonId(event.target.value);
                }}
              >
                {!people.length && (
                  <option value="">
                    {loadingPeople ? "Loading people…" : "Select a person"}
                  </option>
                )}
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.display_name === person.matrix_id
                      ? person.matrix_id
                      : `${person.display_name} (${person.matrix_id})`}
                  </option>
                ))}
                <option value="__add__">+ Add Person</option>
              </select>
            </section>
            {error && (
              <Alert>
                {error}
                <button
                  className="text-button"
                  onClick={() => {
                    void loadPeople();
                    void loadAgents();
                  }}
                >
                  Try Again
                </button>
              </Alert>
            )}
            <section className="agents-section">
              <div className="section-heading">
                <h2>Agents</h2>
                {personId && <span className="count">{agents.length}</span>}
              </div>
              {loadingAgents ? (
                <div className="empty-state" role="status">
                  Loading Agents…
                </div>
              ) : agents.length ? (
                <div className="agent-list">
                  {agents.map((agent) => (
                    <button
                      className="agent-card"
                      key={agent.id}
                      onClick={() => setEditor(agent)}
                    >
                      <AvatarIcon agent={agent} />
                      <span className="agent-info">
                        <strong>{agent.display_name}</strong>
                        <span className="matrix-id">{agent.matrix_id}</span>
                        <Status agent={agent} />
                      </span>
                      <Arrow />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <AvatarIcon />
                  <h3>
                    {personId
                      ? "Ready for a helping hand?"
                      : "Welcome to the family."}
                  </h3>
                  <p>
                    {personId
                      ? "Add an Agent to get started."
                      : "Add a person using their Matrix ID."}
                  </p>
                  {!personId && (
                    <button
                      className="secondary"
                      onClick={() => setAddPerson(true)}
                    >
                      + Add Person
                    </button>
                  )}
                </div>
              )}
              {personId && (
                <button className="add-agent" onClick={() => setEditor("new")}>
                  + Add Agent
                </button>
              )}
            </section>
          </>
        )}
      </main>
      <footer>
        <a href="/source.tar.gz">Source Code</a>
      </footer>
      {addPerson && (
        <AddPerson
          onClose={() => setAddPerson(false)}
          onAdded={(person) => {
            setPeople((current) => [...current, person]);
            setPersonId(person.id);
            setAddPerson(false);
          }}
        />
      )}
      {editor && (
        <AgentEditor
          agent={editor === "new" ? null : editor}
          personId={personId}
          onClose={() => setEditor(null)}
          onChanged={() => void loadAgents()}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
