<p align="center">
  <a href="https://feat.so">
    <img src="https://feat.so/logo/wordmark.png" alt="feat.so" width="320" />
  </a>
</p>

---

# feat Web SDK

Browser / client-side SDK for [feat](https://feat.so) feature flags. Polls a per-environment datafile to the browser and evaluates flags locally with a synchronous cache.

For server code, use [`@feathq/js-sdk`](../js-sdk). For an OpenFeature web Provider, install [`@feathq/openfeature-web`](../openfeature-web) alongside this package.

## Install

```bash
npm install @feathq/web-sdk
# or
yarn add @feathq/web-sdk
```

## Usage

```ts
import { FeatWebClient } from "@feathq/web-sdk";

const client = new FeatWebClient({
  apiKey: "feat_cs_…",                       // client-side ID key
  url: "https://data-01.feat.so",            // optional; this is the default
  anonymous: { storage: "localStorage" },    // optional: auto-mint a stable anonymous user
  cache: { storage: "localStorage" },        // optional: warm cache across page loads
});

await client.ready();

const enabled = client.getBooleanValue("checkout-v2", false);   // sync
const greeting = client.getStringValue("hero-greeting", "Hi");
```

Use a **client-side ID** key (`feat_cs_…`). The key is non-secret and safe to ship in your bundle. Add your site's origin to the key's Authorized URLs in the feat console.

## Reacting to flag changes

```ts
client.on("change", ({ flagKey, newValue }) => {
  console.log(`${flagKey} → ${newValue}`);
});

await client.setContext({
  targetingKey: "user-123",
  user: { plan: "pro" },
});
```

`change` events fire per flag whose evaluated value flipped, after either a context change or a datafile refresh.

## Live streaming

The SDK can hold a Server-Sent Events connection so datafile changes land near-instantly instead of waiting for the next poll. On each update the server pushes the full datafile; the SDK adopts it in version order (no extra HTTP request) and fires `change` events.

By default streaming **follows your subscription**: the stream opens when the first `change` listener is added and closes when the last one is removed, so a page that never listens pays nothing. Override with the `streaming` option:

```ts
new FeatWebClient({ apiKey, streaming: true });  // always stream, opens on ready
new FeatWebClient({ apiKey, streaming: false }); // never stream
```

Polling stays on as a safety net in every mode, so a dropped stream still self-heals.

## OpenFeature

```ts
import { OpenFeature } from "@openfeature/web-sdk";
import { FeatWebClient } from "@feathq/web-sdk";
import { FeatWebProvider } from "@feathq/openfeature-web";

const featClient = new FeatWebClient({ apiKey });
await OpenFeature.setProviderAndWait(new FeatWebProvider(featClient));
await OpenFeature.setContext({ targetingKey: "user-123" });

const enabled = OpenFeature.getClient().getBooleanValue("checkout-v2", false);
```

## SSR / hydration

Fetch the datafile on the server and pass it through to the client to skip the first round trip:

```ts
new FeatWebClient({ apiKey, bootstrap: serverProvidedDatafile });
```

## How it works

- Pre-evaluates every flag against the current context into a `Map` so `getValue` is synchronous.
- Polls every 30 s by default; pauses while the tab is hidden and force-refreshes on visibility restore. Floored at 5 s.
- Optional Server-Sent Events stream for near-instant updates (see [Live streaming](#live-streaming)); polling remains the fallback.
- Cross-tab `BroadcastChannel` sync: when one tab fetches a new datafile, sibling tabs adopt it without their own network call.
- 304-aware via `ETag` / `If-None-Match`.
- `url` must use `https://` if you override it (the constructor rejects plaintext URLs except `http://localhost` for tests).

## Security notes

- `cache: { storage: "localStorage" }` persists the full datafile (including flag rules and segment definitions) under `feat:datafile`. Use only on browsers where you're comfortable with that footprint; default is off.
- `anonymous: { storage: "localStorage" }` writes a stable UUID to `feat:anonymousKey`. Use `storage: "memory"` if you don't want it persisted.
- `BroadcastChannel("feat:datafile")` broadcasts to all same-origin tabs. Any script on the same origin can subscribe; treat the datafile as same-origin-readable.

## License

MIT
