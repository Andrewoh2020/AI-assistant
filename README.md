# AI Assistant

A personal AI assistant modeled on Meta's Muse. Web first, mobile later. The full plan is in
[`docs/architecture-plan.html`](docs/architecture-plan.html); its roadmap (section 11) sets the
build order.

## What is here

| Folder            | What it is                                                                      |
| ----------------- | ------------------------------------------------------------------------------- |
| `apps/web`        | The website people use (Next.js).                                               |
| `apps/api`        | Our backend. It holds every vendor key; the website only talks to it (Fastify). |
| `packages/db`     | The database design (all features, all phases) and the tool that applies it.    |
| `packages/tokens` | Colors, type sizes and spacing shared by web and mobile, with contrast checks.  |
| `scripts`         | `check-secrets.mjs` stops API keys from ever being committed.                   |
| `docs`            | Plans and specs as HTML.                                                        |

## Run it on a computer

Needs Node 22, pnpm 10 and Postgres 16.

```sh
pnpm install
cp .env.example .env          # then fill in DATABASE_URL
pnpm build
pnpm db:migrate               # creates the tables
pnpm --filter @ai-assistant/web start   # open http://localhost:3000/design
```

## Checks that run on every pull request

- **Secret scan**: fails if anything that looks like an API key is in the code.
- **Contrast**: every text and background color pair passes WCAG AA in light and dark mode.
- **Database**: all migrations run up, all the way down, and up again; one user can never read or
  change another user's rows (row-level security).
- **Build and typecheck** for every app and package.

Keys are never stored in this repository. They live in environment variables (see
`.env.example`) or in the cloud environment's network secrets.
