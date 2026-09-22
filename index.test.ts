import assert from "node:assert/strict"
import { test } from "node:test"
import { Credential, Integration, Model, Provider } from "@opencode/plugin"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import { Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { model, setup } from "./index.ts"

type Context = Parameters<typeof setup>[0]
type Event = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer Item> ? Item : never

function credential(accountID: string, access = `${accountID}-token`) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt-browser"),
    access,
    refresh: `${accountID}-refresh`,
    expires: Date.now() + 3_600_000,
    metadata: { accountID },
  })
}

function environment() {
  const providerID = Provider.ID.make("openai")
  const source: ProviderRecord = {
    provider: { ...Provider.Info.empty(providerID), transport: "websocket" },
    models: new Map(["gpt-6-astra", "gpt-5.4", "gpt-5.5-pro", "gpt-5.6"].map((id) => [id, {
      ...Model.Info.default(providerID, Model.ID.make(id)),
      variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
    }])),
  }
  const providers = new Map<string, ProviderRecord>()
  const credentials = new Map<string, Credential.Value>([
    ["cred_personal", credential("personal")],
    ["cred_stampen", credential("stampen")],
    ["cred_key", Credential.Key.make({ type: "key", key: "api-key" })],
  ])
  const calls: string[] = []
  const resolution: { error?: Error } = {}
  const labels = new Map([...credentials.keys()].map((id) => [id, id.slice(5)]))
  let eventController: ReadableStreamDefaultController<Event> | undefined
  const events = new ReadableStream<Event>({ start(controller) { eventController = controller } })
  let transform: ((editor: ProviderEditor) => void) | undefined
  let notification = Promise.withResolvers<void>()
  const unexpected = () => { throw new Error("Unexpected registry operation") }
  const editor: ProviderEditor = {
    get: (id) => id === "openai" ? source : providers.get(id),
    list: () => [source, ...providers.values()],
    add: ({ info, models }) => providers.set(info.id, {
      provider: info,
      models: new Map(models.map((item) => [item.id, item])),
    }),
    update: unexpected,
    remove: (id) => { providers.delete(id) },
    models: { set: unexpected, update: unexpected, remove: unexpected },
  }
  const context: Context = {
    app: { name: "opencode", version: "2.0.7", channel: "release" },
    integration: {
      get: async () => ({
        location: { directory: "/project" },
        data: {
          id: "openai",
          name: "OpenAI",
          methods: [],
          connections: [...credentials.keys()].map((id) => ({ type: "credential", id, label: labels.get(id) ?? id })),
        },
      }),
      connection: {
        active: async () => { throw new Error("Account-bound requests must not select the active account") },
        resolve: async (connection) => {
          if (resolution.error) throw resolution.error
          assert.equal(connection.type, "credential")
          if (connection.type !== "credential") throw new Error("Expected a saved credential")
          calls.push(connection.id)
          return credentials.get(connection.id)
        },
      },
    },
    provider: {
      transform: async (callback) => {
        transform = callback
        callback(editor)
        return { dispose: async () => { providers.clear() } }
      },
      reload: async () => {
        providers.clear()
        transform?.(editor)
        notification.resolve()
      },
    },
    event: {
      subscribe(options) {
        options?.signal?.addEventListener("abort", () => eventController?.close(), { once: true })
        return events.values()
      },
    },
  }
  function selected(id: string) {
    const entry = providers.get(`openai-cred_${id}`)
    assert.ok(entry)
    const selected = entry.models.get("gpt-6-astra")
    assert.ok(selected)
    return model(selected.id, { ...entry.provider.settings, ...selected.settings })
  }
  async function changed() {
    notification = Promise.withResolvers<void>()
    assert.ok(eventController)
    eventController.enqueue({ type: "credential.updated", id: "evt_changed", created: Date.now(), data: {} })
    await notification.promise
  }
  return { context, providers, credentials, calls, selected, resolution, labels, changed }
}

function authorize(selected: ReturnType<typeof model>, url = "https://chatgpt.com/backend-api/codex/responses") {
  return Effect.runPromise(selected.route.auth.apply({
    request: {},
    method: "POST",
    url,
    body: "{}",
    headers: Headers.fromInput({
      Authorization: "Bearer wrong-account",
      "ChatGPT-Account-ID": "wrong-account",
      "OpenAI-Organization": "wrong-organization",
      "OpenAI-Project": "wrong-project",
      "X-Session-Id": "session-123",
    }),
  }))
}

test("saved ChatGPT accounts become separate providers with their model variants", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  assert.deepEqual([...state.providers.values()].map((entry) => entry.provider.name), ["OpenAI — personal", "OpenAI — stampen"])
  for (const entry of state.providers.values()) {
    assert.deepEqual([...entry.models.keys()], ["gpt-6-astra"])
    assert.equal(entry.models.get("gpt-6-astra")?.variants?.[0]?.id, "high")
  }
  const catalog = JSON.stringify([...state.providers.values()].map((entry) => ({
    provider: entry.provider,
    models: [...entry.models.values()],
  })))
  assert.ok(!catalog.includes("personal-token"))
  assert.ok(!catalog.includes("stampen-token"))
})

test("concurrent requests stay account-bound and reuse a pending credential resolution", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  const stampen = state.selected("stampen")
  state.calls.length = 0
  const [first, second, work] = await Promise.all([authorize(personal), authorize(personal), authorize(stampen)])
  assert.equal(first.authorization, "Bearer personal-token")
  assert.equal(second["chatgpt-account-id"], "personal")
  assert.equal(work.authorization, "Bearer stampen-token")
  assert.equal(work["chatgpt-account-id"], "stampen")
  assert.equal(work["session-id"], "session-123")
  assert.equal(work["openai-organization"], undefined)
  assert.equal(work["openai-project"], undefined)
  assert.equal(state.calls.filter((id) => id === "cred_personal").length, 1)

  state.credentials.set("cred_personal", credential("personal", "refreshed-token"))
  assert.equal((await authorize(personal)).authorization, "Bearer refreshed-token")
  assert.equal((await authorize(stampen)).authorization, "Bearer stampen-token")
})

test("missing, expired, and incomplete credentials fail without falling back to another account", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  state.credentials.delete("cred_personal")
  await assert.rejects(authorize(personal), /selected ChatGPT account is unavailable/)
  state.credentials.set("cred_personal", { ...credential("personal"), expires: 0 })
  await assert.rejects(authorize(personal), /selected ChatGPT account is unavailable/)
  state.credentials.set("cred_personal", { ...credential("personal"), metadata: {} })
  await assert.rejects(authorize(personal), /no account ID/)
  assert.equal((await authorize(state.selected("stampen"))).authorization, "Bearer stampen-token")
})

test("credential refresh failures do not expose credential material", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  state.resolution.error = new Error("secret-refresh-token")
  await assert.rejects(authorize(personal), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Could not refresh the selected OpenAI account/)
    assert.ok(!error.message.includes("secret-refresh-token"))
    return true
  })
})

test("account additions, renames, and removals update the catalog without rebinding sessions", { timeout: 2000 }, async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  state.labels.set("cred_personal", "Private")
  state.credentials.set("cred_additional", credential("additional"))
  await state.changed()
  assert.equal(state.providers.get("openai-cred_personal")?.provider.name, "OpenAI — Private")
  assert.equal(state.providers.size, 3)
  assert.equal((await authorize(personal)).authorization, "Bearer personal-token")

  state.credentials.delete("cred_personal")
  await state.changed()
  assert.equal(state.providers.has("openai-cred_personal"), false)
  await assert.rejects(authorize(personal), /binding was removed/)
  assert.equal((await authorize(state.selected("stampen"))).authorization, "Bearer stampen-token")
})

test("credentials are withheld from other endpoints and unloaded bindings", async () => {
  const state = environment()
  const cleanup = await setup(state.context)
  const personal = state.selected("personal")
  try {
    state.calls.length = 0
    for (const url of ["https://example.com/responses", "https://chatgpt.com/other", "http://chatgpt.com/backend-api/codex/responses"]) {
      await assert.rejects(authorize(personal, url), /different endpoint/)
    }
    assert.equal(state.calls.length, 0)
  } finally {
    await cleanup()
  }
  await assert.rejects(authorize(personal), /binding was removed/)
})
