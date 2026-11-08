import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Credential } from "@opencode/plugin"
import type { ModelHooks } from "@opencode/plugin/promise/registration"
import type { SessionHooks, SessionRequest } from "@opencode/plugin/promise/session"

const nativePackage = "@opencode/ai/providers/openai"
const codexBaseURL = "https://chatgpt.com/backend-api/codex"
const tokenBaseURL = "https://api.openai.com/v1"
const tokenSharingModels = new Set([
  "gpt-5.5", "gpt-5.5-fast",
  "gpt-5.6-luna", "gpt-5.6-luna-fast", "gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-terra", "gpt-5.6-terra-fast",
  "gpt-6-astra", "gpt-6-astra-fast", "gpt-6-luna", "gpt-6-luna-fast", "gpt-6-sol", "gpt-6-sol-fast",
  "gpt-6.1-sol", "gpt-6.1-sol-fast", "gpt-6.1-terra", "gpt-6.1-terra-fast",
])

type Context = {
  integration: Pick<Plugin.Context["integration"], "get"> & {
    connection: Pick<Plugin.Context["integration"]["connection"], "resolve">
  }
  provider: Pick<Plugin.Context["provider"], "transform" | "reload">
  model: {
    transform(callback: (editor: {
      list(providerID?: string): readonly Model.Info[]
      remove(providerID: string, modelID: string): void
    }) => void): Promise<{ dispose(): Promise<void> }>
  }
  session: { hook: ModelHooks<Pick<SessionHooks, "context" | "compaction" | "generate" | "title" | "http.request">> }
  event: {
    subscribe(options?: { signal?: AbortSignal }): ReturnType<Plugin.Context["event"]["subscribe"]>
  }
}

type SavedConnection = Extract<Parameters<Plugin.Context["integration"]["connection"]["resolve"]>[0], { type: "credential" }>
type Account = { connection: SavedConnection; kind: "token" | "codex"; baseURL: string }

function accountKind(value: Credential.Value | undefined) {
  if (value?.type !== "oauth") return undefined
  if (value.methodID === "chatgpt-token-sharing") return "token"
  if (value.methodID === "chatgpt-browser" || value.methodID === "chatgpt-headless") return "codex"
  return undefined
}

function isPro(body: Readonly<Record<string, unknown>> | undefined) {
  const reasoning = body?.reasoning
  return typeof reasoning === "object" && reasoning !== null && "mode" in reasoning && reasoning.mode === "pro"
}

function eligible(model: Model.Info, kind: Account["kind"]) {
  // Media generation does not run session HTTP hooks and cannot safely use this account binding.
  if (!model.enabled || (model.type !== undefined && model.type !== "chat") || isPro(model.body)) return false
  const id = model.modelID ?? model.id
  if (kind === "token") return tokenSharingModels.has(id)
  if (id === "gpt-5.6") return false
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/)
  const major = Number(match?.[1])
  return major > 5 || (major === 5 && Number(match?.[2] ?? 0) > 5)
}

function contextLimit(model: Model.Info) {
  const match = (model.modelID ?? model.id).match(/^gpt-(\d+)(?:\.(\d+))?/)
  const major = Number(match?.[1])
  const input = !match || major > 6 || (major === 6 && Number(match[2] ?? 0) >= 1) ? 500_000 : 272_000
  return (model.limit.input || model.limit.context) <= input
    ? model.limit
    : { ...model.limit, input, context: input + model.limit.output }
}

function modelSettings(settings: Model.Info["settings"]): Model.Info["settings"] {
  const {
    apiKey, accessToken, authToken, auth, headers, body, baseURL, queryParams,
    openAIAccountBinding, ...options
  } = settings ?? {}
  return { ...options, store: false, compaction: { type: "summary" } }
}

/** Register named accounts while leaving model construction and execution to OpenCode. */
export async function setup(context: Context) {
  let accounts = new Map<string, Account>()
  const managedProviders = new Set<string>()
  const pending = new Map<string, Promise<Credential.Value | undefined>>()
  const controller = new AbortController()
  let disposed = false

  function resolve(connection: SavedConnection) {
    const current = pending.get(connection.id)
    if (current) return current
    const request = context.integration.connection.resolve(connection).finally(() => pending.delete(connection.id))
    pending.set(connection.id, request)
    return request
  }

  async function synchronize() {
    const { data } = await context.integration.get({ integrationID: "openai" })
    const next = new Map<string, Account>()
    for (const connection of data.connections) {
      if (connection.type !== "credential") continue
      let value: Credential.Value | undefined
      try {
        value = await resolve(connection)
      } catch {
        const previous = accounts.get(`openai-${connection.id}`)
        if (previous) next.set(`openai-${connection.id}`, { ...previous, connection })
        continue
      }
      const kind = accountKind(value)
      if (kind) next.set(`openai-${connection.id}`, { connection, kind, baseURL: kind === "token" ? tokenBaseURL : codexBaseURL })
    }
    accounts = next
    for (const id of next.keys()) managedProviders.add(id)
  }

  await synchronize()
  const registration = await context.provider.transform((editor) => {
    const source = editor.get("openai")
    if (!source) return
    for (const [providerID, account] of accounts) {
      const id = Provider.ID.make(providerID)
      editor.add({
        info: {
          ...Provider.Info.empty(id),
          name: account.connection.label,
          canonical: Provider.ID.make("openai"),
          activation: "enabled",
          package: nativePackage,
          settings: {
            transport: "http",
            baseURL: account.baseURL,
            encoding: "zstd",
            compaction: { type: "summary" },
            store: false,
          },
        },
        models: [...source.models.values()].filter((item) => eligible(item, account.kind)).map((item) => ({
          ...item,
          name: `${account.connection.label} - ${item.name}`,
          providerID: id,
          canonical: Provider.ID.make("openai"),
          package: nativePackage,
          settings: modelSettings(item.settings),
          headers: undefined,
          body: { ...item.body, store: false },
          compatibility: { ...item.compatibility, ...(account.kind === "token" ? { supportsEffortUpdates: false } : {}) },
          cost: [],
          limit: contextLimit(item),
          variants: item.variants?.filter((variant) => !isPro(variant.body)).map((variant) => ({
            ...variant,
            settings: modelSettings(variant.settings),
            headers: undefined,
            body: { ...variant.body, store: false },
          })),
        })),
      })
    }
  })

  const modelRegistration = await context.model.transform((editor) => {
    if (!editor.list().some((item) => item.enabled && accounts.has(item.providerID))) return
    for (const item of editor.list("openai")) editor.remove(item.providerID, item.id)
  })

  const requestRegistration = await context.session.hook("http.request", async (event) => {
    const account = accounts.get(event.model.providerID)
    if (!account) {
      if (managedProviders.has(event.model.providerID)) throw new Error("OpenAI account binding was removed. Select a connected account.")
      return
    }
    if (disposed) throw new Error("OpenAI account binding was removed. Reload the plugin.")
    const destination = new URL(event.request.url)
    const endpoint = new URL(account.baseURL)
    if (destination.origin !== endpoint.origin || !destination.pathname.startsWith(`${endpoint.pathname}/`) ||
      destination.username || destination.password) {
      throw new Error("Refusing to send a ChatGPT credential to a different endpoint.")
    }
    let value: Credential.Value | undefined
    try {
      value = await resolve(account.connection)
    } catch {
      throw new Error("Could not refresh the selected OpenAI account. Reconnect it through /connect.")
    }
    const current = accounts.get(event.model.providerID)
    if (disposed || !current || current.kind !== account.kind || current.baseURL !== account.baseURL) {
      throw new Error("OpenAI account binding was removed. Retry the request.")
    }
    if (value?.type !== "oauth" || accountKind(value) !== account.kind || !value.access || value.expires <= Date.now()) {
      throw new Error("The selected ChatGPT account is unavailable. Reconnect it through /connect.")
    }
    const headers = event.request.headers
    for (const name of ["authorization", "api-key", "x-api-key", "cookie", "openai-organization", "openai-project", "chatgpt-account-id", "originator", "x-codex-beta-features"]) {
      headers.delete(name)
    }
    const accountID = value.metadata?.accountID
    if (account.kind === "codex") {
      if (typeof accountID !== "string" || !accountID) throw new Error("The selected ChatGPT credential has no account ID. Reconnect it through /connect.")
      headers.set("chatgpt-account-id", accountID)
      headers.set("originator", "opencode")
      headers.set("x-codex-beta-features", "remote_compaction_v2")
    } else {
      headers.set("thread-id", event.sessionID)
      headers.set("x-client-request-id", event.sessionID)
    }
    headers.set("authorization", `Bearer ${value.access}`)
    headers.set("session-id", headers.get("x-session-affinity") ?? headers.get("x-session-id") ?? event.sessionID)
  })

  const configureRequest = (event: SessionRequest) => {
    if (!accounts.has(event.model.providerID)) return
    delete event.options.maxTokens
    event.options.store = false
  }
  const hooks = await Promise.all([
    context.session.hook("context", configureRequest),
    context.session.hook("compaction", configureRequest),
    context.session.hook("generate", configureRequest),
    context.session.hook("title", configureRequest),
  ])

  const watching = (async () => {
    for await (const event of context.event.subscribe({ signal: controller.signal })) {
      if (event.type !== "credential.updated" && event.type !== "credential.switched") continue
      await synchronize()
      await context.provider.reload()
    }
  })().catch(() => {
    if (!controller.signal.aborted) console.error("OpenAI account monitoring stopped. Reload the plugin to refresh the account list.")
  })

  return async () => {
    disposed = true
    controller.abort()
    await watching
    accounts.clear()
    await requestRegistration.dispose()
    await modelRegistration.dispose()
    await registration.dispose()
    await Promise.all(hooks.map((hook) => hook.dispose()))
  }
}

export default Plugin.define({ id: "openai-accounts", setup })
