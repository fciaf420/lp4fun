# Build & Test

- Install dependencies (locked):
  - `npm ci`
- Lint:
  - `npm run lint`
- Build (Next.js):
  - `npm run build`
- Start production server:
  - `npm start`
- Local development:
  - `npm run dev`
- Tests:
  - No test suite configured in this repo (no `test` script). Add one before relying on CI tests.

---

# Architecture Overview

- Framework: Next.js 15 (App Router) with TypeScript and TailwindCSS + DaisyUI
- Entry/layout: `app/layout.tsx`, global styles in `app/globals.css`
- Pages/routes:
  - `app/page.tsx` – home
  - Dynamic routes under `app/pools/[[...tokenAddress]]/page.tsx` and `app/wallet/[[...walletPubKeys]]/page.tsx`
  - API routes under `app/api/**` (e.g., `app/api/historical-price/route.ts`)
- Components: `app/components/*` (e.g., `ThemeToggle.tsx`, `Trend.tsx`)
- State/contexts: `app/contexts/*` (e.g., `ThemeContext.tsx`)
- Utilities: `app/utils/*` including:
  - Solana/Web3 helpers: `solana.ts`, `cachedConnection.ts`
  - External data: `jup.ts`, `meteoraAPI.ts`, `birdeye.ts`, `dlmm.ts`
  - Formatting/validation: `numberFormatting.ts`, `formatters.ts`, `validation.ts`
  - Config/constants: `config.ts`
- Types: `app/types/index.ts`
- Config files: `tsconfig.json`, `tailwind.config.ts`, `.eslintrc.json`, `next.config.mjs`

---

# Security

- Secrets and environment variables:
  - `BIRDEYE_API_KEY` is read in `app/api/historical-price/route.ts`
  - Set via environment (e.g., `.env.local` for local dev, deployment env vars in hosting provider)
- External services:
  - Solana RPC via `config.RPC_ENDPOINT` in `app/utils/config.ts`
  - Jupiter APIs (`lite-api.jup.ag`) in `app/utils/jup.ts`
  - Meteora DLMM APIs (`dlmm-api.meteora.ag`) in route pages
  - Birdeye API via server route (adds `x-chain: solana` and `x-api-key` headers)
- Client caching uses `localStorage` for some fetch wrappers; no secrets should be stored client-side
- Do not commit secrets to VCS; prefer environment-injected values

---

# Git Workflows

- Branching:
  - Create feature branches from `main` using a clear prefix, e.g., `feat/*`, `fix/*`, `docs/*`, `chore/*`
- Commits:
  - Use descriptive messages; conventional commit style is recommended (e.g., `feat: ...`, `fix: ...`, `docs: ...`)
- Pull Requests:
  - Open PRs against `main`
  - Required steps before opening/merging:
    - `npm ci`
    - `npm run lint` (fix issues)
    - `npm run build` (must succeed)
  - Include a brief summary, screenshots (if UI changes), and link to any relevant issues

---

# Conventions & Patterns

- Language: TypeScript, strict mode enabled in `tsconfig.json`
- Module resolution: `@/*` path alias maps to repo root
- Components: PascalCase for React components (`*.tsx`), colocate simple components under `app/components`
- Utilities: camelCase filenames under `app/utils`
- Styling: TailwindCSS + DaisyUI; themes configured in `tailwind.config.ts`
- Routing: Next.js App Router under `app/**`; API routes in `app/api/**`
- Linting: Next.js ESLint config via `.eslintrc.json` (`next/core-web-vitals`)
