# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file TypeScript cron job (`index.ts`) that posts a daily "Reader Report" to a Google Chat space. It fetches Weekly Active Readers (WAR) and top-articles data from the EventStream HTTP API (`eventstream.swarajyamag.com`), formats a Google Chat Cards V2 message, and POSTs it to an incoming webhook.

Deployed on Railway as a cron job (`railway.json`: runs daily at 23:30 UTC = 05:00 IST, `restartPolicyType: NEVER`). Running it locally sends a real message to the Chat space — there is no dry-run mode.

## Commands

```bash
npm install
npm start          # tsx index.ts — runs the report once and exits
npx tsc --noEmit   # type-check (strict mode; tsconfig is noEmit-only)
```

No tests, no linter. Requires Node 20+ (uses global `fetch`).

## Required env vars

Copy `.env.example`. All three are required (the script throws on startup if missing):

- `EVENTSTREAM_BASE_URL` — EventStream API base, trailing slashes stripped
- `EVENTSTREAM_TOKEN` — Bearer token (from `API_TOKENS` env on the EventStream service)
- `GCHAT_WEBHOOK_URL` — Google Chat space incoming webhook
- `REPORT_TIMEZONE` (optional) — IANA tz for date labels, default `Asia/Kolkata`

Note: `tsx` doesn't load `.env` by itself — export vars into the shell (or use `tsx --env-file=.env index.ts`) when running locally.

## Architecture notes

- **WAR windows are precise 7×24h windows, not calendar days.** The script computes three exact instants (48h ago, 24h ago, now) via `nowMinus()` and passes each as a full ISO `as_of` datetime to `/api/reports/war?days=7`. Date *labels* shown in the card are those instants rendered in `REPORT_TIMEZONE`; don't conflate the label with the window boundary.
- Card text uses Google Chat's limited HTML subset (`<b>`, `<font color>`, `<br>`) — headlines/authors are escaped via `escapeHtml` before interpolation.
- On any API or webhook failure the script throws and exits 1, which Railway surfaces as a failed cron run.
