# OpenCode OpenAI Accounts

Lists saved ChatGPT accounts as separate model providers, for example:

```text
Elva - GPT-6.1 Sol
Stampen - GPT-6.1 Sol
```

Select an account and model together. Concurrent sessions use their selected accounts without changing OpenCode's globally active account.

## Install

Requires OpenCode V2 with the public provider/model transforms and session HTTP hooks available in **2.2.6**. Save and name accounts through `/connect`, using **Sign in with ChatGPT** or a legacy Codex login. API-key and environment connections are excluded.

```sh
npm ci
```

Add the checkout directory to `~/.config/opencode/opencode.jsonc`, preserving other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-openai-accounts"]
}
```

Load the directory, not `index.ts`, and do not load a second installed copy. Configuration reloads automatically; `/reload` forces a refresh.

## Upgrade behavior

**Routine OpenCode upgrades do not require matching this plugin's AI-runtime dependencies to the host.** Provider definitions reference `@opencode/ai/providers/openai` by name. OpenCode loads its own bundled implementation, so protocol serialization, streaming, compression, and runtime fixes follow the installed OpenCode release.

The plugin does not construct native models, replace runtime routes, patch global fetch, or import Effect or the AI runtime directly. Its only direct runtime dependency is the public `@opencode/plugin` SDK. That SDK remains pinned for reproducible installation; it does not need updating just to select the host's newer OpenAI implementation.

This is not a promise of compatibility with every future release. A breaking public plugin API change or a change to ChatGPT subscription policy may still require maintenance. Model eligibility and subscription limits remain explicit plugin policy because OpenCode does not currently expose per-provider saved-connection binding with native account-aware policy.

## Account behavior and security

- Provider IDs remain `openai-<credentialID>`. Account renames preserve existing selections; reconnecting creates a new credential ID and requires selecting the new entry.
- Credentials remain in OpenCode. The session HTTP hook resolves the bound saved connection at request time, including normal OAuth refresh. Concurrent resolutions for the same account are shared.
- Missing, expired, removed, or changed authentication methods fail closed. Requests never select the globally active account as a fallback.
- Credentials and inherited authentication headers are excluded from provider/model definitions. The hook validates the destination before supplying a token and removes conflicting authentication/account headers.
- Token-sharing accounts use `https://api.openai.com/v1`. Legacy Codex accounts use `https://chatgpt.com/backend-api/codex` with account-specific headers.
- All accounts use **HTTP**, compressed requests, and summary compaction. This avoids experimental WebSocket hooks and the native compaction endpoint's account-specific requirements.
- Requests explicitly set `store: false` and omit output-token overrides for the agent loop, compaction, transient session generation, and titles.
- Generic OpenAI models are hidden while at least one named account has available models. The integration and saved logins remain intact.
- Model names, reasoning variants, and definitions come from OpenCode's catalog, filtered through subscription eligibility policy. Subscription pricing is zero; pro reasoning variants are excluded. Input caps are 500,000 for GPT-6.1 and newer and 272,000 for older models, without increasing smaller catalog limits.

## Supported scope

Named-account authentication covers **session-based chat requests**, including the agent loop, titles, compaction, and `session.generate`.

Standalone `experimental.generate` calls do not run session hooks and are not supported through these named providers. Media models are intentionally excluded for the same reason; they must not appear usable while bypassing account authentication. Use the native OpenAI integration for those operations.

If a saved legacy account returns an expired-token error despite normal credential resolution, reconnect it through `/connect`; the plugin does not implement a separate OAuth refresh flow.

## Development

```sh
npm run check
npm test
```

The existing tests cover account isolation and refresh, failure behavior, endpoint restrictions, labels and renames, request bodies, all session request kinds, stateless settings, inherited-authentication removal, model visibility, subscription policy, and cleanup without real credentials.

References: [public plugin API](https://opencode.ai/docs/build/plugins/server), [host provider loader](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/provider.ts), [host model resolver](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/model-resolver.ts).
