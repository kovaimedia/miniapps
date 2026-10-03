# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SwarajyaPix — a bulk image generator for Swarajya using Google Gemini (`gemini-3-pro-image-preview` for images, `gemini-2.5-flash` for prompt extraction). Deployed on Railway via Nixpacks (`nixpacks.toml`).

## Commands

```bash
bun install          # install dependencies
bun run dev          # run with watch mode (server.ts, port 3000 or $PORT)
bun start            # run without watch
```

There are no tests or linters, except `bun run test-generated-route.ts` — a standalone script (spawns the server against a throwaway temp dir) that checks GET and HEAD on `/generated/*` return matching status/headers for an existing and a nonexistent file.

## Architecture

No build step, no framework, no bundler:

- **`gemini.ts`** — shared Gemini core used by both `server.ts` and `bot.ts`: API key resolution/client, `generateImage`/`editImage` (`gemini-3-pro-image-preview`), `verifyImage` (`gemini-2.5-flash` QA-checks an image against a text requirement, returns a JSON verdict), and `produceVerified` — generate-or-edit, then verify-and-auto-correct up to `MAX_CORRECTION_ROUNDS` (2) before giving up. This is the one QA loop every single-image generation path (web, bot, MCP) calls into; don't reimplement it per-caller.
- **`server.ts`** — the entire web backend. A single `Bun.serve()` fetch handler with inline routing (if-chains on `url.pathname`). Serves the two HTML files, the JSON API, and the MCP endpoint.
- **`mcp.ts`** — exposes `generate_image`/`generate_images`/`edit_image` as MCP tools (`@modelcontextprotocol/sdk`, `WebStandardStreamableHTTPServerTransport`, stateless — a fresh `McpServer` per request, no session tracking) by calling straight into `./gemini`. `server.ts` imports `handleMcpRequest` from here and calls it directly inside the fetch handler for any `/mcp*` path — no extra process or port, since the Web Standards transport speaks plain Fetch `Request`/`Response`.
- **`bot.ts`** — optional Telegram bot, imports only from `./gemini` (not from `server.ts`). Started by server.ts via dynamic import only when `TELEGRAM_BOT_TOKEN` is set. Long-polls `getUpdates`; auth is a Telegram user-ID allowlist (`TELEGRAM_ALLOWED_IDS`, comma-separated). Replying to a bot image applies that text as a verified correction; replying "hd" resends full-res as a document. Sent images are cached in-memory (message_id → base64, FIFO-capped) so reply-chains can edit the uncompressed original; falls back to downloading the compressed copy from Telegram after a restart.
- **`index.html`** — self-contained single-page frontend (inline CSS/JS) for synchronous generation: paste/parse prompts, generate one-by-one via `/api/generate`, lightbox with image editing, download.
- **`batch.html`** — self-contained frontend for the Gemini Batch API flow: create a batch job, poll it, fetch results.

### AI verification of generated images

`/api/generate`, `/api/edit-image`, and both MCP tools always run `produceVerified` — there is no `verify: false`/skip switch anywhere in the public surfaces (an earlier version had one; it was removed after an MCP caller used it to bypass QA and shipped an image with raw prompt labels like "HEADLINE:" rendered into it — see `verifyImage`'s prompt in `gemini.ts`, which now explicitly flags that failure mode). Response shape adds `verified` (`true`/`false`), `rounds` (auto-correction rounds actually used), and `problems` (unresolved verifier complaints, if any). `/api/edit-image` also accepts an optional `originalPrompt` so the verifier checks the edit against the full intent, not just the instruction in isolation — mirrors `bot.ts`'s `handleCorrection`. `index.html` surfaces a `⚠ review` badge (hover for the flagged problems) when `verified === false`.

**Batch API results are intentionally not verified** — `/api/batch/*` is unchanged; verifying+auto-correcting per-image there would mean synchronous Gemini calls defeating the point of the async Batch API.

### MCP endpoint

`/mcp/<MCP_SECRET>` (also accepts `Authorization: Bearer <MCP_SECRET>` or `?key=<MCP_SECRET>`) exposes `generate_image`, `generate_images`, and `edit_image` as MCP tools over Streamable HTTP — same path-secret convention as the `xmcpbridge` project. Disabled unless `MCP_SECRET` is set. Unauthenticated `/mcp*` requests get a plain `401`; everything else still falls through to the normal `404` so OAuth-discovery probes (`/.well-known/*`, `/register`) from connector clients don't trigger dynamic client registration.

`generate_images` takes up to 15 prompts in one call and runs them concurrently (staggered 2s apart, `BULK_STAGGER_MS` in `mcp.ts`) instead of the caller looping one `generate_image` call at a time — a sequential loop is what caused multi-minute waits in the first place, since each verified generation already takes 30-90s. It returns only text (one URL + verification status per prompt), never inline image data, since inlining up to 15 images in one response would be enormous.

All three MCP tools return images via `/generated/...` URLs so results can be forwarded. `generate_image`/`edit_image` return the image two ways: as an inline `image` content block (for the calling model to see it) and as a plain-text `Image URL: .../generated/YYYY/MM/DD/<uuid>.ext` (for the calling model to *forward* it — an `image` content block is a vision block, so the model never sees its base64 as copyable text and can't pass it as an argument to another tool; the URL is). `imageStore.ts` backs `/generated/*` by writing to a Railway volume (`swarajyapix-generated`, mounted at `/data`, set via `GENERATED_IMAGES_DIR=/data/generated`) partitioned by date — real persistence across restarts/redeploys, not an in-memory cache. Locally (no `GENERATED_IMAGES_DIR`) it falls back to `./data/generated` (gitignored). The server's own `/mcp` handler resolves the externally-visible scheme from `X-Forwarded-Proto` (see `originOf` in `mcp.ts`) rather than `req.url`'s own scheme, since Railway's edge terminates TLS and forwards internally over plain HTTP — using `req.url` directly would hand out `http://` URLs for an `https://`-only service.

### Auth and sessions

- Users come from the `AUTH_USERS` env var: comma-separated `username:password` pairs. No hashing.
- Login (`POST /api/login`) issues a `crypto.randomUUID()` token stored in an **in-memory** `Map` — all sessions die on server restart, and the frontend re-logins via `localStorage`-cached credentials failing `/api/me`.
- All `/api/*` routes except `/api/login` require `Authorization: Bearer <token>`.
- Per-user in-memory rate limit: 10 requests/minute on `/api/generate` and `/api/edit-image`.

### Batch persistence

Batch jobs are persisted as JSON files in `data/batches/<batch-id>.json` (`BatchRecord` interface in server.ts). The Gemini batch job name is stored in the record; `POST /api/batch/:id/poll` re-queries Gemini, updates state (`pending → running → succeeded/failed/expired`), and on success extracts base64 images into the record — handling both inline responses and the file-download fallback (`ai.files.download`). `GET /api/batch/list` strips the (large) `results` field; full images come from `GET /api/batch/:id/results`. Batches are scoped to the creating username.

### API key resolution

`GOOGLE_API_KEY` is read from env/`.env`, with a fallback that parses `~/.claude/.env` — keep this fallback intact for local dev.

## Conventions

- Images travel as base64 strings in JSON throughout (API responses, batch records, frontend state).
- Frontend pages share the same `localStorage` keys (`swarajyapix_token`, `swarajyapix_user`) so login carries across `/` and `/batch`.
- When adding API routes, follow the existing pattern: validate token first, then rate-limit (for generation endpoints), then parse/validate body, and return `Response.json({ error }, { status })` on failure.
