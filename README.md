# AI Assistant

A personal AI assistant modeled on Meta's Muse. Web first, mobile later. The full plan is in
[`docs/architecture-plan.html`](docs/architecture-plan.html); its roadmap (section 11) sets the
build order.

## What is here

| Folder                | What it is                                                                      |
| --------------------- | ------------------------------------------------------------------------------- |
| `apps/web`            | The website people use (Next.js).                                               |
| `apps/api`            | Our backend. It holds every vendor key; the website only talks to it (Fastify). |
| `packages/agent`      | The assistant's instructions, model choice and the tools it may use.            |
| `packages/api-client` | The backend's request and response shapes, shared by web and (later) mobile.    |
| `packages/db`         | The database design (all features, all phases) and the tool that applies it.    |
| `packages/tokens`     | Colors, type sizes and spacing shared by web and mobile, with contrast checks.  |
| `scripts`             | `check-secrets.mjs` stops API keys from ever being committed.                   |
| `docs`                | Plans and specs as HTML.                                                        |

## Run it on a computer

Step-by-step guide for reviews: [`docs/local-testing.html`](docs/local-testing.html). In short,
with Node 22 and Postgres 16 installed and an empty `ai_assistant` database:

```sh
pnpm install
cp .env.example .env          # then fill in DATABASE_URL, the two keys and SIGNUP_CODE
pnpm local                    # builds, applies migrations, starts http://localhost:3000
```

The website runs the backend inside itself (`apps/web/app/api`), so one command starts both.
Open http://localhost:3000, choose "Create an account" and use the invite code from
`SIGNUP_CODE`. `/design` shows the colors and type.

In the cloud development environment the vendor keys come from network secrets instead of `.env`;
start with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` so requests go
through that proxy.

## Hosting

Vercel project `ai-assistant` (root `apps/web`) with its own Neon database. Pushes to GitHub do
not deploy (`apps/web/vercel.json`); reviews are tested locally. A production deploy applies
migrations during the build (`scripts/migrate-on-deploy.mjs`); preview deploys never touch the
database. The hosted site needs `SESSION_SECRET`, `SIGNUP_CODE`, `TRAVILA_API_KEY` and
`DEEPSEEK_API_KEY` in the Vercel project settings.

## How a question is answered

1. The website sends the question to our backend, which saves it and starts a run on Travila
   (DeepSeek answers; Claude Sonnet 5 takes over if DeepSeek fails).
2. The website asks for the run's progress every 1.5 seconds. Each check moves the run forward:
   when the model asks to search or read a page, our backend does it (DeepSeek Search and Fetch),
   checks it first (no private addresses, no private details in searches), marks the results as
   untrusted, numbers each source and hands the results back.
3. When the answer arrives, links that weren't among the sources are removed, citations are
   renumbered 1, 2, 3, and the answer is saved with its Sources list and the model's reasoning
   (shown folded under "How I worked this out").

## Checks that run on every pull request

- **Secret scan**: fails if anything that looks like an API key is in the code.
- **Contrast**: every text and background color pair passes WCAG AA in light and dark mode.
- **Database**: all migrations run up, all the way down, and up again; one user can never read or
  change another user's rows (row-level security).
- **Backend**: user B gets "403" for user A's chat; a full research turn with cited sources; a page
  with planted instructions is flagged; private-network pages are refused; a refresh mid-answer
  doesn't send the question twice; Stop ends a run at once; clean-room side chats get no memory.
- **Build and typecheck** for every app and package.

Keys are never stored in this repository. They live in environment variables (see
`.env.example`) or in the cloud environment's network secrets.
