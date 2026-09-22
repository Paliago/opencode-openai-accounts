import { AIError, AuthenticationError, LanguageModel } from "@opencode/ai"
import * as OpenAI from "@opencode/ai/providers/openai"
import { Auth } from "@opencode/ai/route"
import { Credential, Model, Plugin, Provider } from "@opencode/plugin"
import { Effect } from "effect"
import { Headers } from "effect/unstable/http"

const baseURL = "https://chatgpt.com/backend-api/codex"

type Context = {
  app: Plugin.Context["app"]
  integration: Pick<Plugin.Context["integration"], "get" | "connection">
  provider: Pick<Plugin.Context["provider"], "transform" | "reload">
  event: Plugin.Context["event"]
}

type SavedConnection = {
  type: "credential"
  id: string
  label: string
}

type Binding = {
  resolve: () => Promise<Credential.Value | undefined>
  version: string
}

type Runtime = {
  bindings: Map<string, Binding>
  pending: WeakMap<Context["app"], Map<string, Promise<Credential.Value | undefined>>>
}

declare global {
  var openCodeOpenAIAccountRuntime: Runtime | undefined
}

// OpenCode caches native provider modules separately from hot-reloaded plugin modules.
const runtime: Runtime = globalThis.openCodeOpenAIAccountRuntime ??= {
  bindings: new Map(),
  pending: new WeakMap(),
}

function resolveCredential(context: Context, connection: SavedConnection) {
  let pending = runtime.pending.get(context.app)
  if (!pending) {
    pending = new Map()
    runtime.pending.set(context.app, pending)
  }
  const current = pending.get(connection.id)
  if (current) return current
  const requests = pending
  const request = context.integration.connection.resolve(connection).finally(() => requests.delete(connection.id))
  requests.set(connection.id, request)
  return request
}

function isChatGPT(value: Credential.Value | undefined): value is Credential.OAuth {
  return value?.type === "oauth" &&
    (value.methodID === "chatgpt-browser" || value.methodID === "chatgpt-headless")
}

function authenticationError(message: string) {
  return new AIError({ reason: new AuthenticationError({ message }) })
}

/** OpenCode native provider entrypoint. Credentials are resolved at request time. */
export function model(modelID: string, settings: OpenAI.Settings) {
  const { openAIAccountBinding, ...options } = settings
  if (typeof openAIAccountBinding !== "string" || !runtime.bindings.has(openAIAccountBinding)) {
    throw new Error("OpenAI account binding is unavailable. Reload the plugin and select the account again.")
  }

  const native = OpenAI.model(modelID, { ...options, baseURL })
  const auth = Auth.custom((input) => Effect.gen(function* () {
    const destination = new URL(input.url)
    if (destination.origin !== "https://chatgpt.com" ||
      !destination.pathname.startsWith("/backend-api/codex/") || destination.username || destination.password) {
      return yield* Effect.fail(authenticationError("Refusing to send a ChatGPT credential to a different endpoint."))
    }

    const binding = runtime.bindings.get(openAIAccountBinding)
    if (!binding) {
      return yield* Effect.fail(authenticationError("OpenAI account binding was removed. Select a connected account."))
    }
    const credential = yield* Effect.tryPromise({
      try: () => binding.resolve(),
      catch: () => authenticationError("Could not refresh the selected OpenAI account. Reconnect it through /connect."),
    })
    if (!isChatGPT(credential) || !credential.access || credential.expires <= Date.now()) {
      return yield* Effect.fail(authenticationError("The selected ChatGPT account is unavailable. Reconnect it through /connect."))
    }
    const accountID = credential.metadata?.accountID
    if (typeof accountID !== "string" || !accountID) {
      return yield* Effect.fail(authenticationError("The selected ChatGPT credential has no account ID. Reconnect it through /connect."))
    }

    let headers = input.headers
    for (const name of ["authorization", "api-key", "x-api-key", "cookie", "openai-organization", "openai-project", "chatgpt-account-id"]) {
      headers = Headers.remove(headers, name)
    }
    return Headers.setAll(headers, {
      authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": accountID,
      originator: "opencode",
      "x-codex-beta-features": "remote_compaction_v2",
      "user-agent": headers["user-agent"] ?? `opencode/${binding.version}`,
      ...(headers["x-session-id"] ? { "session-id": headers["x-session-id"] } : {}),
    })
  }))
  return LanguageModel.update(native, { route: native.route.with({ auth }) })
}

function isPro(body: Readonly<Record<string, unknown>> | undefined) {
  const reasoning = body?.reasoning
  return typeof reasoning === "object" && reasoning !== null && "mode" in reasoning && reasoning.mode === "pro"
}

function isChatGPTModel(model: Model.Info) {
  if (!model.enabled || isPro(model.body)) return false
  const id = model.modelID ?? model.id
  if (id === "gpt-5.5" || id === "gpt-5.3-codex-spark") return true
  if (id === "gpt-5.5-pro" || id === "gpt-5.6") return false
  // ponytail: follows OpenCode 2.0.7's Codex eligibility policy; replace with account discovery when exposed.
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/)
  const major = Number(match?.[1])
  return major > 5 || (major === 5 && Number(match?.[2] ?? 0) > 4)
}

/** Register one provider per saved ChatGPT account and follow account changes. */
export async function setup(context: Context) {
  let accounts = new Map<string, { connection: SavedConnection; bindingID: string }>()
  const controller = new AbortController()
  const entrypoint = new URL(import.meta.url)
  entrypoint.searchParams.set("account-runtime", crypto.randomUUID())

  async function synchronize() {
    const { data } = await context.integration.get({ integrationID: "openai" })
    const next = new Map<string, { connection: SavedConnection; bindingID: string }>()
    for (const connection of data.connections) {
      if (connection.type !== "credential") continue
      let credential: Credential.Value | undefined
      try {
        credential = await resolveCredential(context, connection)
      } catch {
        console.warn(`OpenAI account ${connection.label} could not be resolved; reconnect it through /connect.`)
        continue
      }
      if (!isChatGPT(credential)) continue
      const bindingID = accounts.get(connection.id)?.bindingID ?? crypto.randomUUID()
      runtime.bindings.set(bindingID, {
        resolve: () => resolveCredential(context, connection),
        version: context.app.version,
      })
      next.set(connection.id, { connection, bindingID })
    }
    for (const [id, account] of accounts) {
      if (!next.has(id)) runtime.bindings.delete(account.bindingID)
    }
    accounts = next
  }

  await synchronize()
  const registration = await context.provider.transform((editor) => {
    const source = editor.get("openai")
    if (!source) return
    for (const { connection, bindingID } of accounts.values()) {
      const id = Provider.ID.make(`openai-${connection.id}`)
      editor.add({
        info: {
          ...Provider.Info.empty(id),
          name: `OpenAI — ${connection.label}`,
          canonical: Provider.ID.make("openai"),
          activation: "enabled",
          package: entrypoint.href,
          transport: source.provider.transport ?? "websocket",
          compaction: source.provider.compaction,
          settings: { baseURL, openAIAccountBinding: bindingID },
        },
        models: [...source.models.values()].filter(isChatGPTModel).map((item) => ({
          ...item,
          providerID: id,
          canonical: Provider.ID.make("openai"),
          package: entrypoint.href,
          settings: { ...item.settings, baseURL, openAIAccountBinding: bindingID },
          cost: [],
          limit: { ...item.limit, context: 400_000, input: 272_000 },
          variants: item.variants?.filter((variant) => !isPro(variant.body)),
        })),
      })
    }
  })

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
    controller.abort()
    await watching
    await registration.dispose()
    for (const account of accounts.values()) runtime.bindings.delete(account.bindingID)
  }
}

export default Plugin.define({ id: "openai-accounts", setup })
