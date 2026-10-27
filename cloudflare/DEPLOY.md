# Deploy The Nadda Daily on Cloudflare

The public site stays a static repo. GitHub Pages keeps publishing `main` unchanged. This Worker, at `daily.natlada.com`, proxies that site and stores every issue plus visitor counts in D1.

`cloudflare/dist/worker.js` is the same file as `cloudflare/src/worker.js`. Upload that one module. There is no build and no asset upload.

Until the `CLOUDFLARE_API_TOKEN` repository secret exists, GitHub Actions cannot deploy this Worker. After a Worker change, upload `cloudflare/dist/worker.js` again with the API. The Pages redirect and the sync change do not change the D1 schema.

## Bindings, vars, secrets

| Name | Kind | Value |
| --- | --- | --- |
| `DB` | D1 binding | database name `nadda-daily` |
| `ORIGIN_BASE` | var | `https://natlada-haus.github.io/nadda-daily` |
| `GITHUB_REPO` | var | `natlada-haus/nadda-daily` |
| `GITHUB_REF` | var | `main` |
| `GITHUB_API` | var, unused | left in place so an older config still deploys; the Worker does not call the GitHub API |
| `GITHUB_RAW_BASE` | var | `https://raw.githubusercontent.com` |
| `ADMIN_PASSWORD` | secret | password for `/admin` |
| `SYNC_TOKEN` | secret | bearer token for `POST /admin/sync` |
| `VISITOR_SALT` | secret | long random string mixed into the daily visitor hash |

`compatibility_date` is `2026-10-27`. `workers_dev` is false, so the custom domain is the public hostname. Do not put routes in `wrangler.toml`; the domain is attached once, outside Wrangler, and later deploys leave it in place.

Cron (UTC), also stored in `wrangler.toml`:

| Cron | Asia/Bangkok |
| --- | --- |
| `30 23 * * *` | 06:30, just after the 06:17 publish |
| `0 0 * * *` | 07:00 retry |
| `0 6 * * *` | 13:00 catch-up for edits |

Cron and on-request sync read GitHub Pages (`content/latest.json`, each `content/YYYY-MM-DD.json` already in D1, and `content/manifest.json` if it exists), then raw files if Pages 404s. They do not call `api.github.com`. A missing file stays in D1. One run fetches at most 20 issue files, newest first, and remembers where it stopped so a later run continues. `updated_at` moves only when the JSON changes; `ingested_at` stays. A 429, 403, or 5xx backs off from 30 seconds up to an hour. A visitor request syncs when the last good sync is older than 2 minutes (or 3 seconds when `remaining` > 0), unless that backoff is active.

`POST /admin/sync` with `Content-Type: application/json` and `{ "issues": [{ "date", "body" }] }` stores those bodies directly (`mode` is `push`) and does not fetch GitHub. For 20 minutes afterwards, Pages/raw sync will not overwrite those rows. An empty POST, or the admin button, still reads Pages/raw.

## First deploy (API)

1. Create D1 database `nadda-daily`. Copy its UUID.
2. Apply `cloudflare/schema.sql`. The D1 console accepts the whole file. The query API accepts one statement at a time; the file is six statements (three `CREATE TABLE`, three `CREATE INDEX`), all `IF NOT EXISTS`.
3. Upload `cloudflare/dist/worker.js` as an ES module Worker named `nadda-daily`, with the binding, vars, secrets, compatibility date, and crons above.
4. Attach custom domain `daily.natlada.com` (zone on this account; Cloudflare creates the DNS record).
5. Backfill until `remaining` is 0:

```bash
curl -fsS -X POST https://daily.natlada.com/admin/sync \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  -H "Accept: application/json"
```

Fifteen current issues fit in one call. Repeat while `remaining` is not 0. `POST /admin/sync` also accepts an admin session cookie or header `X-Sync-Token`.

## GitHub Actions

`.github/workflows/cloudflare-deploy.yml` runs on a push to `main` that touches `cloudflare/**` or that workflow. It writes the D1 UUID into `wrangler.toml`, runs `wrangler d1 migrations apply nadda-daily --remote`, deploys, then ingests.

`.github/workflows/cloudflare-sync.yml` runs on a push to `main` that touches `content/**` or `latest.json`. It reads the issue files in that checkout (the workflow's `GITHUB_TOKEN` is only used to check the repo out) and POSTs them to `/admin/sync`. The Worker does not need a GitHub token. Design changes (`index.html`, `app.js`, `style.css`, `redirect.js`, `404.html`) need no workflow: the Worker proxies GitHub Pages, so they show up when Pages finishes publishing. Issue JSON is served from D1 once sync has stored it, including edits, so the archive updates without waiting for Pages. Files removed from the repo stay in D1.

The Pages redirect lives in `index.html`, `404.html`, and `redirect.js`. It runs only when the hostname ends with `github.io`, and it keeps the path (`/nadda-daily/issue/...` becomes `/issue/...` on `daily.natlada.com`). `generate.py` does not write those files, so the morning content commit leaves the redirect in place. There is no HTTP redirect on the Pages origin, because the Worker fetches that origin and would follow one into a loop.

### Repository secrets

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy and D1 migrations |
| `CLOUDFLARE_ACCOUNT_ID` | account id |
| `CLOUDFLARE_D1_DATABASE_ID` | UUID of `nadda-daily`; replaces the all-zero id in `wrangler.toml` |
| `SYNC_TOKEN` | same value as the Worker secret `SYNC_TOKEN` |

Optional repository variable `SYNC_URL` (default `https://daily.natlada.com/admin/sync`).

Set these before the workflow runs. The Worker, database, secrets, and custom domain must already exist; this repo's first deploy is the API step above. A later push deploys new code and applies new files in `cloudflare/migrations/`. The sync workflow expects the live Worker to answer `mode: "push"`. Until `dist/worker.js` is uploaded, that workflow stops after one request instead of retrying.

### API token permissions

Custom token, this account only:

- Account → **Workers Scripts** → **Edit** (deploy the existing Worker and its cron triggers)
- Account → **D1** → **Edit** (apply migrations)
- Account → **Account Settings** → **Read** (Wrangler checks the account id)

No zone permission is required, because the custom domain is not in `wrangler.toml`.

The token does not need permission to create a database. If a future run has to create the Worker script itself, that call needs Workers admin (or the legacy “Edit Cloudflare Workers”) as well. After the script exists, Edit is enough. Do not grant DNS or Workers Routes unless you later add a route to the config.

## What updates on its own

- New morning edition, or an edit to a past `content/YYYY-MM-DD.json`: the content workflow ingests it. Cron and the next page view do the same if the workflow did not run.
- HTML, CSS, JS, images: proxied from GitHub Pages with a short cache (`no-cache` for HTML, 60 seconds for other assets).
- Worker code: the deploy workflow publishes `src/worker.js` and applies migrations.

## Local check

```bash
cd cloudflare
npm ci
npm test
npx wrangler d1 migrations apply nadda-daily --local
```

`npm test` runs the Worker under Wrangler's local runtime with a local D1 database. For `wrangler dev`, put `ADMIN_PASSWORD`, `SYNC_TOKEN`, and `VISITOR_SALT` in `cloudflare/.dev.vars` (gitignored). Requests whose user agent looks like a bot, including `curl`, are not counted.
