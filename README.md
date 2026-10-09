# OpenCode OpenAI Accounts

An OpenCode V2 plugin that gives every saved ChatGPT account its own provider in the model picker:

```text
OpenAI — Elva
  GPT-6 Astra
  GPT-5.6 Luna

OpenAI — Stampen
  GPT-6 Astra
  GPT-5.6 Luna
```

Choose the account and model together. Sessions can use different accounts concurrently; the plugin never changes OpenCode's active OpenAI account.

## Install

Requires OpenCode **2.0.22+** and its built-in OpenAI integration. Accounts must already be saved through `/connect` using ChatGPT sign-in (`chatgpt-token-sharing`, the current default) or a legacy Codex browser/device login (`chatgpt-browser`, `chatgpt-headless`). API-key and environment connections are excluded. If a saved token fails to refresh (for example HTTP 400 from the OAuth endpoint), reconnect it through `/connect`.

Install the plugin from GitHub:

```sh
npm_config_min_release_age=0 opencode plugin add github:Paliago/opencode-openai-accounts
```

The command disables npm's release-age restriction only for this installation, which is needed when your global npm configuration delays recently published packages.

Open or restart OpenCode, then use `/connect` to add each ChatGPT account. OpenCode installs the plugin globally and checks the `main` branch for updates. To apply an available update immediately:

```sh
opencode plugin update github:Paliago/opencode-openai-accounts
```

## Development

Clone the repository and install its dependencies:

```sh
git clone https://github.com/Paliago/opencode-openai-accounts.git
cd opencode-openai-accounts
npm ci
npm run check
npm test
```

To load the checkout instead of the installed package, add its directory to the existing `plugins` array in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-openai-accounts"]
}
```

Keep your other plugin entries. Configure the **directory**, not `index.ts`. Reload the project's configuration after adding it, and remove the installed package entry to avoid loading the plugin twice.

For local development, this checkout has an ignored `.opencode/opencode.jsonc` that enables the plugin only in this project. OpenCode clients working here can already select the account-specific providers.

## Behavior

- Provider names use the saved account labels. Rename them through `/connect`.
- Provider IDs use credential IDs: `openai-<credentialID>/<modelID>`. Renaming an account preserves existing model selections.
- Adding or removing an account updates the catalog. Reconnecting creates a new credential ID, so select its new provider in existing sessions.
- Credentials remain in OpenCode's database. Each request resolves its bound credential through OpenCode, including automatic OAuth refresh.
- Concurrent requests for the same account share an in-progress credential resolution. Different accounts resolve independently.
- A missing, expired, or unusable credential fails the request. It never falls back to another saved account or `OPENAI_API_KEY`.
- The native OpenAI runtime handles HTTP, WebSocket, and compaction requests. The adapter supplies account-specific authentication and restricts each credential to its own endpoint:
  - Legacy Codex logins (`chatgpt-browser`, `chatgpt-headless`) use `https://chatgpt.com/backend-api/codex` with `chatgpt-account-id`, `originator`, and Codex beta headers.
  - Current ChatGPT sign-ins (`chatgpt-token-sharing`) use `https://api.openai.com/v1` with Bearer auth only (no account ID header, following OpenCode 2.0.26's `opencode.provider.chatgpt` policy).
- Token-sharing providers allow only OpenCode's token-sharing model allowlist (`gpt-5.5`, `gpt-5.6-luna/sol/terra` and `fast` variants, `gpt-6-astra/luna/sol` and `fast` variants, `gpt-6.1-sol`/`fast`); Codex providers use the legacy Codex eligibility policy. Both set `cost: []` and strip `pro` reasoning variants.
- Account requests omit the output-token limit rejected by ChatGPT, including session prompts, compaction, transient generation, and titles.
- The original `OpenAI` provider remains available with its usual active-account behavior.

The account entries inherit OpenAI model definitions and reasoning variants. Subscription pricing and context limits follow OpenCode 2.0.7's built-in ChatGPT policy. Model eligibility is currently the same static policy, rather than a per-account entitlement lookup.

## Verification

`npm test` uses Node's built-in test runner to check catalog updates, concurrent account isolation, refreshed credentials, failure behavior, endpoint restrictions, output-limit omission, and cleanup. No network credentials are needed for those checks.

During development on OpenCode 2.0.7, both real saved accounts successfully completed concurrent transient generation requests and normal session prompts through their own provider entries. The temporary verification sessions were removed afterward.

## References

- [V2 provider accounts](https://opencode.ai/v2/docs/cli/providers/)
- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins/)
- [OpenCode 2.0.7 OpenAI integration](https://github.com/anomalyco/opencode/blob/v2.0.7/packages/core/src/plugin/provider/openai.ts)
