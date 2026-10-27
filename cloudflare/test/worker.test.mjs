import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createTestHarness } from "wrangler";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const cloudflareRoot = path.resolve(import.meta.dirname, "..");
const issues = new Map();

let origin;
let harness;
let worker;

function gitSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function contentType(rel) {
  if (rel.endsWith(".html")) return "text/html; charset=utf-8";
  if (rel.endsWith(".css")) return "text/css; charset=utf-8";
  if (rel.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (rel.endsWith(".json")) return "application/json; charset=utf-8";
  if (rel.endsWith(".png")) return "image/png";
  if (rel.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function send(res, status, body, type) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "content-type": type || "text/plain; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visitor(ip, extra = {}) {
  const country = extra.country || "TH";
  return {
    "User-Agent": "Mozilla/5.0 (test) Chrome/120.0.0.0",
    "CF-Connecting-IP": ip,
    "CF-IPCountry": country,
    "MF-CF-Blob": JSON.stringify({ country }),
    ...(extra.referrer ? { Referer: extra.referrer } : {}),
  };
}

function hit(pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", "Mozilla/5.0 (test) Chrome/120.0.0.0");
  return worker.fetch(`http://daily.natlada.com${pathname}`, { ...init, headers });
}

async function sync() {
  const res = await hit("/admin/sync", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-sync-token",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

async function pageViews() {
  const env = await worker.getEnv();
  const listed = await env.DB.prepare(
    "SELECT path, issue_date, country, referrer, visitor_hash FROM page_views ORDER BY id"
  ).all();
  return listed.results || [];
}

async function waitForViews(atLeast) {
  for (let i = 0; i < 40; i++) {
    const rows = await pageViews();
    if (rows.length >= atLeast) return rows;
    await delay(50);
  }
  const rows = await pageViews();
  throw new Error(`expected at least ${atLeast} views, saw ${rows.length}`);
}

after(async () => {
  if (harness) await harness.close();
  if (origin) await new Promise((resolve) => origin.close(resolve));
});

describe("nadda daily worker", () => {
  it("serves the paper, archives issues, records views, and guards admin", async () => {
    assert.equal(
      await readFile(path.join(cloudflareRoot, "schema.sql"), "utf8"),
      await readFile(path.join(cloudflareRoot, "migrations/0001_init.sql"), "utf8"),
    );
    assert.equal(
      await readFile(path.join(cloudflareRoot, "src/worker.js"), "utf8"),
      await readFile(path.join(cloudflareRoot, "dist/worker.js"), "utf8"),
    );

    for (const date of ["2026-10-13", "2026-10-27"]) {
      const body = await readFile(path.join(repoRoot, "content", `${date}.json`), "utf8");
      issues.set(date, { body, raw: body, origin: true });
    }

    origin = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === "/api/repos/natlada-haus/nadda-daily/git/trees/main") {
        const tree = [...issues.entries()].map(([date, issue]) => ({
          path: `content/${date}.json`,
          mode: "100644",
          type: "blob",
          sha: gitSha(issue.body),
          size: Buffer.byteLength(issue.body),
        }));
        send(res, 200, JSON.stringify({ sha: "tree", truncated: false, tree }), "application/json");
        return;
      }
      const raw = pathname.match(/^\/raw\/natlada-haus\/nadda-daily\/main\/content\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (raw) {
        const issue = issues.get(raw[1]);
        if (!issue || issue.raw == null) return send(res, 404, "missing raw");
        return send(res, 200, issue.raw, "text/plain; charset=utf-8");
      }
      const apiFile = pathname.match(/^\/api\/repos\/natlada-haus\/nadda-daily\/contents\/content\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (apiFile) {
        const issue = issues.get(apiFile[1]);
        if (!issue) return send(res, 404, "missing api");
        return send(res, 200, issue.body, "text/plain; charset=utf-8");
      }
      if (pathname.startsWith("/site/")) {
        const rel = pathname.slice("/site/".length);
        const dated = rel.match(/^content\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (dated) {
          const issue = issues.get(dated[1]);
          if (!issue || !issue.origin) return send(res, 404, "missing origin issue");
          return send(res, 200, issue.body, "application/json; charset=utf-8");
        }
        const file = path.resolve(repoRoot, rel);
        if (file !== repoRoot && !file.startsWith(`${repoRoot}${path.sep}`)) return send(res, 400, "bad path");
        try {
          return send(res, 200, await readFile(file), contentType(rel));
        } catch {
          return send(res, 404, "missing file");
        }
      }
      send(res, 404, `unknown ${pathname}`);
    });
    await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const address = /** @type {import("node:net").AddressInfo} */ (origin.address());
    const base = `http://127.0.0.1:${address.port}`;

    harness = createTestHarness({
      root: cloudflareRoot,
      workers: [{
        configPath: path.join(cloudflareRoot, "wrangler.toml"),
        vars: {
          ORIGIN_BASE: `${base}/site`,
          GITHUB_API: `${base}/api`,
          GITHUB_RAW_BASE: `${base}/raw`,
          GITHUB_REPO: "natlada-haus/nadda-daily",
          GITHUB_REF: "main",
          SYNC_BATCH_LIMIT: "1",
        },
        secrets: {
          ADMIN_PASSWORD: "test-admin-pass",
          SYNC_TOKEN: "test-sync-token",
          VISITOR_SALT: "test-visitor-salt",
        },
      }],
    });
    await harness.listen();
    worker = harness.getWorker();
    await worker.applyD1Migrations("DB");

    const denied = await hit("/admin/sync", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    assert.equal(denied.status, 401);

    const first = await sync();
    assert.equal(first.ok, true);
    assert.equal(first.inserted, 1);
    assert.equal(first.remaining, 1);
    assert.equal(first.checked, 2);
    const second = await sync();
    assert.equal(second.inserted, 1);
    assert.equal(second.remaining, 0);

    const env = await worker.getEnv();
    const stored = await env.DB.prepare(
      "SELECT date, headline, ingested_at, updated_at FROM issues ORDER BY date"
    ).all();
    assert.deepEqual(stored.results.map((row) => row.date), ["2026-10-13", "2026-10-27"]);
    assert.match(stored.results[0].headline, /Heavy-rain warning/);
    assert.match(stored.results[1].headline, /Speaker Sophon/);
    const ingestedAt = stored.results[0].ingested_at;

    const home = await hit("/");
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /The Nadda Daily/);
    assert.match(homeHtml, /nd-archive-bar/);
    assert.match(homeHtml, /href="\/archive"/);

    const issuePage = await hit("/issue/2026-10-13");
    assert.equal(issuePage.status, 200);
    const issueHtml = await issuePage.text();
    assert.match(issueHtml, /<base href="\/">/);
    assert.match(issueHtml, /nd-issue-boot/);

    const css = await hit("/style.css");
    assert.equal(css.status, 200);
    assert.match(await css.text(), /--paper/);

    const jsonIssue = await hit("/content/2026-10-13.json");
    assert.equal(jsonIssue.status, 200);
    const issuePayload = await jsonIssue.json();
    assert.equal(issuePayload.date, "2026-10-13");
    assert.match(issuePayload.thailand[0].title, /Heavy-rain warning/);

    const early = await waitForViews(2);
    const baseline = early.length;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    await hit("/", { headers: visitor("203.0.113.10", { referrer: "https://news.ycombinator.com/item?id=99&utm=1" }) });
    await hit("/", { headers: visitor("203.0.113.10") });
    await hit("/?date=2026-10-13", { headers: visitor("203.0.113.11", { country: "US" }) });
    await hit("/issue/2026-10-27", { headers: visitor("203.0.113.11") });
    await hit("/archive", { headers: visitor("203.0.113.12", { country: "JP" }) });
    const counted = await waitForViews(baseline + 5);
    assert.equal(counted.length, baseline + 5);
    await hit("/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "CF-Connecting-IP": "198.51.100.8",
      },
    });
    await hit("/admin");
    await hit("/favicon-32.png");
    await delay(300);
    const rows = await pageViews();
    assert.equal(rows.length, baseline + 5);
    const thHomes = rows.filter((row) => row.path === "/" && row.country === "TH");
    assert.equal(thHomes.length, 2);
    assert.equal(thHomes[0].visitor_hash, thHomes[1].visitor_hash);
    assert.match(thHomes[0].visitor_hash, /^[a-f0-9]{64}$/);
    assert.equal(thHomes[0].issue_date, today);
    assert.equal(thHomes.filter((row) => row.referrer === "news.ycombinator.com/item").length, 1);
    const dated = rows.find((row) => row.path === "/?date=2026-10-13");
    assert.equal(dated.issue_date, "2026-10-13");
    assert.equal(dated.country, "US");
    assert.notEqual(dated.visitor_hash, thHomes[0].visitor_hash);
    const issueView = rows.find((row) => row.path === "/issue/2026-10-27");
    assert.equal(issueView.issue_date, "2026-10-27");
    const archiveView = rows.find((row) => row.path === "/archive" && row.country === "JP");
    assert.equal(archiveView.issue_date, null);
    for (const row of rows) {
      const blob = JSON.stringify(row);
      assert.equal(blob.includes("203.0.113"), false);
      assert.equal(blob.includes("198.51.100"), false);
    }

    const archive = await hit("/archive");
    assert.equal(archive.status, 200);
    const archiveHtml = await archive.text();
    assert.match(archiveHtml, /Heavy-rain warning/);
    assert.match(archiveHtml, /Speaker Sophon/);
    assert.match(archiveHtml, /href="\/issue\/2026-10-27"/);
    await waitForViews(rows.length + 1);

    const badLogin = await hit("/admin/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=wrong-password",
    });
    assert.equal(badLogin.status, 401);
    assert.match(await badLogin.text(), /รหัสผ่านไม่ถูกต้อง/);

    const goodLogin = await hit("/admin/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=test-admin-pass",
    });
    assert.equal(goodLogin.status, 303);
    const setCookie = (goodLogin.headers.getSetCookie?.() || [goodLogin.headers.get("set-cookie") || ""]).join("\n");
    const session = setCookie.split(";")[0];
    assert.match(session, /^nd_session=/);
    const beforeDash = (await pageViews()).length;
    const dash = await hit("/admin", { headers: { Cookie: session } });
    assert.equal(dash.status, 200);
    const dashHtml = await dash.text();
    assert.match(dashHtml, /กราฟรายวัน/);
    assert.match(dashHtml, /ฉบับที่ถูกเปิด/);
    assert.match(dashHtml, /ประเทศ/);
    assert.match(dashHtml, /2026-10-27/);
    await delay(200);
    assert.equal((await pageViews()).length, beforeDash);

    await delay(30);
    const edited = issues.get("2026-10-13").body.replace(
      "Heavy-rain warning for West & South",
      "Edited rain warning",
    );
    issues.set("2026-10-13", { body: edited, raw: edited, origin: true });
    const editSync = await sync();
    assert.equal(editSync.updated, 1);
    assert.equal(editSync.remaining, 0);
    const afterEdit = await env.DB.prepare(
      "SELECT headline, ingested_at, updated_at FROM issues WHERE date = ?"
    ).bind("2026-10-13").first();
    assert.equal(afterEdit.headline, "Edited rain warning");
    assert.equal(afterEdit.ingested_at, ingestedAt);
    assert.notEqual(afterEdit.updated_at, ingestedAt);
    assert.match(await (await hit("/content/2026-10-13.json")).text(), /Edited rain warning/);

    const frozen = afterEdit.updated_at;
    const again = await sync();
    assert.equal(again.updated, 0);
    assert.equal(again.remaining, 0);
    const still = await env.DB.prepare("SELECT updated_at FROM issues WHERE date = ?").bind("2026-10-13").first();
    assert.equal(still.updated_at, frozen);

    const canonical = edited.replace("Edited rain warning", "API rain warning");
    issues.set("2026-10-13", { body: canonical, raw: edited, origin: true });
    const apiSync = await sync();
    assert.equal(apiSync.updated, 1);
    const viaApi = await env.DB.prepare("SELECT headline FROM issues WHERE date = ?").bind("2026-10-13").first();
    assert.equal(viaApi.headline, "API rain warning");

    issues.get("2026-10-27").origin = false;
    assert.match(await (await hit("/content/2026-10-27.json")).text(), /Speaker Sophon/);
    issues.delete("2026-10-27");
    const kept = await sync();
    assert.equal(kept.ok, true);
    const stillThere = await env.DB.prepare("SELECT headline FROM issues WHERE date = ?").bind("2026-10-27").first();
    assert.match(stillThere.headline, /Speaker Sophon/);

    const cronBody = JSON.stringify({
      date: "2026-10-01",
      issue_no: 99,
      tagline: "from cron",
      thailand: [{ lead: true, title: "Cron headline" }],
    });
    issues.set("2026-10-01", { body: cronBody, raw: cronBody, origin: true });
    await worker.scheduled({ cron: "30 23 * * *", scheduledTime: new Date() });
    const cronRow = await env.DB.prepare("SELECT headline FROM issues WHERE date = ?").bind("2026-10-01").first();
    assert.equal(cronRow.headline, "Cron headline");

    await env.DB.prepare(
      "UPDATE meta SET value = ? WHERE key IN ('last_sync_at', 'last_sync_attempt')"
    ).bind("2000-01-01T00:00:00.000Z").run();
    const refreshed = cronBody.replace("Cron headline", "Request refresh headline");
    issues.set("2026-10-01", { body: refreshed, raw: refreshed, origin: false });
    assert.match(await (await hit("/content/2026-10-01.json")).text(), /Request refresh headline/);

    const logout = await hit("/admin/logout", {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: session },
    });
    assert.equal(logout.status, 303);
    const locked = await hit("/admin");
    assert.match(await locked.text(), /รหัสผ่าน/);
    assert.doesNotMatch(await (await hit("/admin")).text(), /กราฟรายวัน/);
  });
});
