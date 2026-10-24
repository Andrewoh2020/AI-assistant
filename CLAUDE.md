# Ability (Muse competitor)

The product is called **Ability** (Andrew's earlier startup brand, adopted 2026-10-23). Logos and
brand colors are in `packages/tokens/brand` and the `brand` export of `packages/tokens`. Internal
package names stay `@ai-assistant/*`.

Andrew's personal AI assistant, built to compete with Meta's Muse. Andrew is not an engineer:
explain choices in plain words, never hand him install steps or manual commands, and do the
setup, rebuilds and restarts yourself.

## How Andrew works

- Match Muse's behaviour, not just its look. Light mode only for now.
- No friction: no separate "Edit" buttons; click straight into a field, save on click-away.
- Simplify: cut optional/advanced options rather than add them.
- Cost-conscious: no frequent background jobs or polling. Explain any scheduled job's
  frequency and cost in plain terms before adding it.
- Don't give unverified instructions for third-party apps; check them first.
- Plans and specs as HTML files, not Markdown.

## Running it on Andrew's Mac

- One app (Next.js web + Fastify API in-process): `pnpm local` builds, migrates and starts it
  on http://localhost:3000.
- It runs as a login service, `com.andrew.ai-assistant`. After pulling new code:
  `pnpm install`, `pnpm build`, `pnpm db:migrate`, then
  `launchctl kickstart -k gui/$(id -u)/com.andrew.ai-assistant`. Check localhost:3000 loads.
- Keys live only in the app's private `.env`. Never print it or copy keys anywhere else.
- Everything (Gmail, flight check-in, share links, Clerk sign-in, the Ability branding) is merged
  into `main` (2026-10-24). Start new work from `main`.
  Push work to GitHub so it can be picked up from the cloud again later.

## Live site

- https://ai-assistant-ashy-eight-29.vercel.app (Vercel project `ai-assistant`, team `andrewoh`).
  Git deploys are off; deploy with `vercel deploy --prod` only when Andrew says so.
  Migrations run on deploy (`scripts/migrate-on-deploy.mjs`).
- Beta testers use the live site. Never read testers' chats, database rows or logs; Andrew sees
  a tester's chat through the link from "Share" in the chat's ⋯ menu.
- Andrew's other apps share the same Vercel and Travila accounts and must never be touched:
  Orbit, Castability, Loop, Cross-border advisor.

## Things learned the hard way

- Main model is DeepSeek through Travila. It drops optional tool arguments: mark every field a
  tool needs as required.
- The browser (Browser Use) must never buy or pay. A run's cost setting is a cap, not the price
  (real runs cost under a cent); say "cap" when showing it.
- Tests: Postgres at `postgres://postgres:postgres@localhost:5432/ai_assistant_test`, `pnpm test`.
  On Andrew's Mac it's `postgres://andrewoh@localhost:5432/ai_assistant_test`; the database tests
  are skipped unless `DATABASE_URL` points there.
- Flights are matched by route and departure time, not flight number: codeshare emails give the
  same flight different numbers (kept as `codeshares`).
