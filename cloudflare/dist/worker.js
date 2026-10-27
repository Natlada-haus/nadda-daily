/**
 * The Nadda Daily — single-file ES module Worker.
 *
 * Bindings: D1 `DB`
 * Secrets: ADMIN_PASSWORD, SYNC_TOKEN, VISITOR_SALT
 * Vars: ORIGIN_BASE, GITHUB_REPO, GITHUB_REF, GITHUB_RAW_BASE
 *
 * Serves the GitHub Pages site, keeps every issue in D1 (upsert by date),
 * and records privacy-friendly page views. Sync reads GitHub Pages and raw
 * files, or a JSON body posted by GitHub Actions. It does not call the
 * GitHub API. Upload this file as-is; it has no imports and no build step.
 */

const DEFAULT_ORIGIN = "https://natlada-haus.github.io/nadda-daily";
const DEFAULT_REPO = "natlada-haus/nadda-daily";
const DEFAULT_REF = "main";
const DEFAULT_RAW = "https://raw.githubusercontent.com";
const DIRECT_PUSH_WINDOW_MS = 20 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_TTL_SEC = 60 * 60 * 24 * 14;
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|wget|curl\/|python-requests|axios|headless|lighthouse|pagespeed|pingdom|uptime|monitor|semrush|ahrefs|petalbot|bytespider|gptbot|claudebot|amazonbot|applebot|bingbot|duckduckbot|yandex|baiduspider|sogou|ia_archiver|embedly|slackbot|discordbot|twitterbot|linkedinbot/i;

// Dedupes overlapping syncs inside one isolate. Not request data.
let syncInFlight = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      return await route(request, env, ctx, url);
    } catch (error) {
      console.error(JSON.stringify({
        message: "unhandled error",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("application/json") || url.pathname.startsWith("/admin/sync")) {
        return json({ ok: false, error: "Internal error" }, 500);
      }
      return htmlResponse(errorPage("The edition is temporarily unavailable.", 500), 500);
    }
  },

  async scheduled(controller, env) {
    const cron = controller && controller.cron;
    try {
      const result = await runSync(env);
      console.log(JSON.stringify({
        message: "cron sync",
        cron,
        inserted: result.inserted || 0,
        updated: result.updated || 0,
        unchanged: result.unchanged || 0,
        remaining: result.remaining || 0,
        errors: (result.errors || []).length,
        throttled: Boolean(result.throttled),
      }));
      if (result.error && !result.throttled) throw new Error(result.error);
    } catch (error) {
      console.error(JSON.stringify({
        message: "cron sync failed",
        cron,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  },
};

async function route(request, env, ctx, url) {
  const path = url.pathname;
  if (request.method === "POST" && path === "/admin/login") return login(request, env);
  if (request.method === "POST" && path === "/admin/logout") return logout(request);
  if (request.method === "POST" && path === "/admin/sync") return syncEndpoint(request, env);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Method not allowed", 405);
  }

  if (path === "/admin" || path.startsWith("/admin/")) {
    if (path === "/admin" || path === "/admin/") return adminPage(request, env, url);
    return text("Not found", 404);
  }
  if (path === "/archive" || path === "/archive/") return archivePage(request, env, ctx, url);
  if (path.startsWith("/issue/")) return issuePage(request, env, ctx, url);

  const dated = path.match(/^\/content\/(\d{4}-\d{2}-\d{2})\.json$/);
  if (dated) return issueJson(request, env, ctx, dated[1]);
  if (path === "/content/latest.json") return latestJson(env, ctx);

  if (!isSafeAssetPath(path === "/" ? "/index.html" : path)) return text("Not found", 404);

  if (path === "/" || path === "/index.html") return homePage(request, env, ctx, url);
  const assetPath = path;
  const response = await proxyAsset(env, assetPath, url.search);
  return response;
}

function isSafeAssetPath(pathname) {
  if (!pathname.startsWith("/") || pathname.length > 240) return false;
  if (pathname.includes("\\") || pathname.includes("\0")) return false;
  const parts = pathname.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  return /^\/[A-Za-z0-9._~/-]*$/.test(pathname);
}

async function homePage(request, env, ctx, url) {
  refreshInBackground(env, ctx);
  const response = await renderSite(env, "/");
  if (response.status === 200) noteView(ctx, env, request, url);
  return response;
}

async function issuePage(request, env, ctx, url) {
  const match = url.pathname.match(/^\/issue\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (!match) return htmlResponse(errorPage("ไม่พบฉบับนี้", 404), 404);
  refreshInBackground(env, ctx);
  const response = await renderSite(env, `/issue/${match[1]}`);
  if (response.status === 200) noteView(ctx, env, request, url);
  return response;
}

async function renderSite(env, canonicalPath) {
  let upstream;
  try {
    upstream = await originFetch(env, "/index.html", "");
  } catch (error) {
    console.error(JSON.stringify({
      message: "origin fetch failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return htmlResponse(errorPage("The edition is temporarily unavailable.", 502), 502);
  }
  if (!upstream.ok) {
    return htmlResponse(errorPage("The edition is temporarily unavailable.", 502), 502);
  }
  const html = decorateHtml(await upstream.text(), canonicalPath);
  return htmlResponse(html, 200, "no-cache");
}

function decorateHtml(html, canonicalPath) {
  const canonical = `https://daily.natlada.com${canonicalPath}`;
  if (/<link\b[^>]*\brel=["']canonical["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<link\b[^>]*\brel=["']canonical["'][^>]*>/i,
      `<link rel="canonical" href="${canonical}">`,
    );
  } else {
    html = html.replace(/<head[^>]*>/i, (tag) => `${tag}<link rel="canonical" href="${canonical}">`);
  }
  const issueRoute = canonicalPath.startsWith("/issue/");
  if (!/<base\s/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (tag) => `${tag}<base href="/">`);
  }
  if (!html.includes("nd-archive-bar")) {
    const bar = `<style id="nd-archive-style">.nd-archive-bar{max-width:1180px;margin:0 auto;padding:10px 16px 0;text-align:right;font:400 13px/1 "Cormorant Garamond","Noto Serif Thai",Georgia,serif;letter-spacing:.16em;text-transform:uppercase}.nd-archive-bar a{color:#6b675f;text-decoration:none;border-bottom:.5px solid #6b675f}</style><p class="nd-archive-bar"><a href="/archive">คลังฉบับ · Archive</a></p>`;
    html = html.replace(/<body[^>]*>/i, (tag) => `${tag}${bar}`);
  }
  if (issueRoute && !html.includes("nd-issue-boot")) {
    const boot = `<script id="nd-issue-boot">(function(){var m=location.pathname.match(/\\/issue\\/(\\d{4}-\\d{2}-\\d{2})\\/?$/);if(!m)return;var orig=URLSearchParams.prototype.get;URLSearchParams.prototype.get=function(k){var v=orig.call(this,k);if(k==="date"&&(v==null||v===""))return m[1];return v;};})();</script>`;
    html = html.replace(/<script\s+src=["']app\.js["']/i, `${boot}<script src="app.js"`);
  }
  return html;
}

async function issueJson(request, env, ctx, date) {
  if (!DATE_RE.test(date)) return text("Not found", 404);
  await refreshAndWait(env, ctx);
  try {
    const row = await env.DB.prepare("SELECT content FROM issues WHERE date = ?").bind(date).first();
    if (row && typeof row.content === "string") {
      return new Response(row.content, { headers: jsonHeaders("no-cache") });
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "issue read failed",
      date,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return proxyAsset(env, `/content/${date}.json`, "");
}

async function latestJson(env, ctx) {
  await refreshAndWait(env, ctx);
  const proxied = await proxyAsset(env, "/content/latest.json", "");
  if (proxied.ok) return proxied;
  try {
    const row = await env.DB.prepare("SELECT content FROM issues ORDER BY date DESC LIMIT 1").first();
    if (row && typeof row.content === "string") {
      return new Response(row.content, { headers: jsonHeaders("no-cache") });
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "latest fallback failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return proxied;
}

async function archivePage(request, env, ctx, url) {
  await refreshAndWait(env, ctx);
  let rows = [];
  try {
    const listed = await env.DB.prepare(
      "SELECT date, issue_no, headline, tagline FROM issues ORDER BY date DESC"
    ).all();
    rows = listed.results || [];
  } catch (error) {
    console.error(JSON.stringify({
      message: "archive query failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  const items = rows.filter((row) => DATE_RE.test(row.date)).map((row) => {
    const when = formatLong(row.date);
    const title = row.headline || row.tagline || row.date;
    const no = row.issue_no ? `No. ${row.issue_no}` : "";
    return `<li><a href="/issue/${row.date}"><span class="when">${esc(when.en)}<span class="th">${esc(when.th)}</span></span><span class="hed">${esc(title)}</span><span class="no">${esc(no)}</span></a></li>`;
  }).join("");
  const body = `
    <div class="topline"><span>The Nadda Daily</span><span><a href="/">วันนี้ · Today</a></span></div>
    <header class="mast"><h1>คลังฉบับ</h1><div class="tag">Every morning edition, kept.</div></header>
    <div class="dateline"><span>${rows.length} issues</span><span lang="th">เก็บไว้ในคลัง แม้ไฟล์ต้นฉบับจะเปลี่ยนภายหลัง</span></div>
    ${items ? `<ul class="archive-list">${items}</ul>` : `<p class="loading">ยังไม่มีฉบับในคลัง ระบบจะดึงให้อัตโนมัติในอีกสักครู่</p>`}
    <footer>The Nadda Daily · Archive</footer>`;
  const response = htmlResponse(shell("คลังฉบับ · The Nadda Daily", body, false, "/archive"), 200, "no-store");
  if (response.status === 200) noteView(ctx, env, request, url);
  return response;
}

async function adminPage(request, env, url) {
  if (!(await isAdmin(request, env))) return loginPage(url, false);
  let stats;
  try {
    stats = await loadStats(env);
  } catch (error) {
    console.error(JSON.stringify({
      message: "stats failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return htmlResponse(errorPage("ยังอ่านสถิติไม่ได้", 500), 500, true);
  }
  const banner = url.searchParams.get("synced") === "1"
    ? `<p class="banner">ซิงก์แล้ว · เพิ่ม ${intParam(url, "inserted")} · แก้ ${intParam(url, "updated")} · คงเดิม ${intParam(url, "unchanged")} · ค้าง ${intParam(url, "remaining")} · ผิดพลาด ${intParam(url, "errors")}</p>`
    : "";
  const cards = [
    ["วันนี้", stats.today],
    ["7 วัน", stats.week],
    ["30 วัน", stats.month],
  ].map(([label, bucket]) => `
    <article class="card">
      <div class="l">${esc(label)}</div>
      <div class="n">${fmt(bucket.views)}</div>
      <div class="sub">เข้าชม · ผู้ไม่ซ้ำ ${fmt(bucket.uniques)}</div>
    </article>`).join("");
  const maxViews = Math.max(1, ...stats.daily.map((day) => day.views));
  const chart = stats.daily.some((day) => day.views > 0)
    ? stats.daily.map((day) => {
      const width = day.views ? Math.max(2, Math.round((day.views / maxViews) * 100)) : 0;
      return `<div class="bar"><span class="lbl">${esc(shortDay(day.day))}</span><span class="track"><span class="fill" style="width:${width}%"></span></span><span class="num">${fmt(day.views)} <span class="u">${fmt(day.uniques)}</span></span></div>`;
    }).join("")
    : `<p class="loading">ยังไม่มียอดเข้าชม</p>`;
  const issueRows = stats.issues.length
    ? stats.issues.map((row) => `<tr><td><a href="/issue/${esc(row.date)}">${esc(row.date)}</a><div class="sub">${esc(row.headline || "")}</div></td><td>${fmt(row.views)}</td><td>${fmt(row.uniques)}</td></tr>`).join("")
    : `<tr><td colspan="3">ยังไม่มี</td></tr>`;
  const referrerRows = stats.referrers.length
    ? stats.referrers.map((row) => `<tr><td>${esc(row.referrer === "(direct)" ? "พิมพ์เอง / ไม่มีแหล่งที่มา" : row.referrer)}</td><td>${fmt(row.views)}</td></tr>`).join("")
    : `<tr><td colspan="2">ยังไม่มี</td></tr>`;
  const countryRows = stats.countries.length
    ? stats.countries.map((row) => `<tr><td>${esc(countryName(row.country))}</td><td>${fmt(row.views)}</td><td>${fmt(row.uniques)}</td></tr>`).join("")
    : `<tr><td colspan="3">ยังไม่มี</td></tr>`;
  const body = `
    <div class="topline"><span>The Nadda Daily</span><span>Admin</span></div>
    <header class="mast"><h1>ผู้เข้าชม</h1><div class="tag">นับเฉพาะหน้าฉบับ ไม่รวมบอตและหน้านี้</div></header>
    <div class="dateline"><span>${esc(stats.todayLabel)}</span><span>คลัง ${fmt(stats.archiveCount)} ฉบับ${stats.latestIssue ? ` · ล่าสุด ${esc(stats.latestIssue)}` : ""}</span><span>ซิงก์ ${esc(stats.lastSync || "—")}</span></div>
    ${banner}
    <p class="note">ผู้ไม่ซ้ำใช้แฮชรายวันของ IP + เบราว์เซอร์ + วัน + เกลือ จึงไม่เก็บ IP และคนเดิมคนละวันนับแยกในกรอบ 7 และ 30 วัน</p>
    <div class="cards">${cards}</div>
    <section><h2>กราฟรายวัน <small>30 วัน · เข้าชม / ไม่ซ้ำ</small></h2>${chart}</section>
    <section><h2>ฉบับที่ถูกเปิด <small>30 วัน</small></h2><table class="plain"><thead><tr><th>ฉบับ</th><th>เข้าชม</th><th>ไม่ซ้ำ</th></tr></thead><tbody>${issueRows}</tbody></table></section>
    <section><h2>แหล่งที่มา <small>30 วัน</small></h2><table class="plain"><tbody>${referrerRows}</tbody></table></section>
    <section><h2>ประเทศ <small>30 วัน</small></h2><table class="plain"><thead><tr><th>ประเทศ</th><th>เข้าชม</th><th>ไม่ซ้ำ</th></tr></thead><tbody>${countryRows}</tbody></table></section>
    <form method="post" action="/admin/sync" class="tools"><button class="btn" type="submit">ดึงฉบับล่าสุด · Sync</button></form>
    <form method="post" action="/admin/logout" class="tools"><button class="btn" type="submit">ออกจากระบบ</button></form>
    <footer>The Nadda Daily · เฉพาะผู้ดูแล</footer>`;
  return htmlResponse(shell("ผู้เข้าชม · The Nadda Daily", body, true), 200, "no-store", true);
}

function loginPage(url, failed) {
  const message = failed || url.searchParams.get("e") === "1"
    ? `<p class="warn">รหัสผ่านไม่ถูกต้อง</p>`
    : "";
  const body = `
    <div class="topline"><span>The Nadda Daily</span><span>Admin</span></div>
    <header class="mast"><h1>ผู้ดูแล</h1><div class="tag">สำหรับคนทำหนังสือพิมพ์ฉบับนี้</div></header>
    ${message}
    <form method="post" action="/admin/login" class="login">
      <label>รหัสผ่าน <input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">เข้าสู่ระบบ</button>
    </form>
    <p class="center"><a href="/">กลับไปฉบับวันนี้</a></p>`;
  return htmlResponse(shell("เข้าสู่ระบบ · The Nadda Daily", body, true), failed ? 401 : 200, "no-store", true);
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) return loginPage(new URL(request.url), true);
  let provided = "";
  try {
    const form = await request.formData();
    provided = String(form.get("password") || "").slice(0, 200);
  } catch {
    provided = "";
  }
  if (!(await fixedEqual(provided, env.ADMIN_PASSWORD))) {
    console.log(JSON.stringify({ message: "admin login failed" }));
    return loginPage(new URL(request.url), true);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const sig = await hmacHex(env.ADMIN_PASSWORD, String(exp));
  const headers = new Headers(loginPage(new URL(request.url), false).headers);
  headers.set("Location", "/admin");
  headers.set("Set-Cookie", sessionCookie(`${exp}.${sig}`, request, SESSION_TTL_SEC));
  return new Response(null, { status: 303, headers });
}

function logout(request) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Set-Cookie": sessionCookie("", request, 0),
      "Cache-Control": "no-store",
    },
  });
}

async function syncEndpoint(request, env) {
  if (!(await canSync(request, env))) return json({ ok: false, error: "Unauthorized" }, 401);
  let pushed = null;
  try {
    pushed = await readPushedIssues(request);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const result = pushed ? await runDirectSync(env, pushed) : await runSync(env);
  const accept = request.headers.get("Accept") || "";
  const auth = request.headers.get("Authorization") || request.headers.get("X-Sync-Token");
  if (auth || accept.includes("application/json")) {
    return json(result, result.error ? 502 : 200);
  }
  const query = new URLSearchParams({
    synced: "1",
    inserted: String(result.inserted || 0),
    updated: String(result.updated || 0),
    unchanged: String(result.unchanged || 0),
    remaining: String(result.remaining || 0),
    errors: String((result.errors || []).length),
  });
  return new Response(null, {
    status: 303,
    headers: { Location: `/admin?${query}`, "Cache-Control": "no-store" },
  });
}

async function loadStats(env) {
  const today = bangkokDay();
  const weekStart = addDays(today, -6);
  const monthStart = addDays(today, -29);
  const summary = async (start) => {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS uniques
       FROM page_views WHERE day >= ? AND day <= ?`
    ).bind(start, today).first();
    return { views: num(row && row.views), uniques: num(row && row.uniques) };
  };
  const todayStats = await summary(today);
  const weekStats = await summary(weekStart);
  const monthStats = await summary(monthStart);
  const dailyRows = await env.DB.prepare(
    `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS uniques
     FROM page_views WHERE day >= ? AND day <= ? GROUP BY day`
  ).bind(monthStart, today).all();
  const byDay = new Map((dailyRows.results || []).map((row) => [row.day, row]));
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDays(today, -i);
    const row = byDay.get(day);
    daily.push({ day, views: num(row && row.views), uniques: num(row && row.uniques) });
  }
  const issueRows = await env.DB.prepare(
    `SELECT v.issue_date AS date, COUNT(*) AS views, COUNT(DISTINCT v.visitor_hash) AS uniques,
            i.headline AS headline
     FROM page_views v
     LEFT JOIN issues i ON i.date = v.issue_date
     WHERE v.day >= ? AND v.day <= ? AND v.issue_date IS NOT NULL AND v.issue_date != ''
     GROUP BY v.issue_date
     ORDER BY views DESC
     LIMIT 8`
  ).bind(monthStart, today).all();
  const referrerRows = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(referrer, ''), '(direct)') AS referrer, COUNT(*) AS views
     FROM page_views WHERE day >= ? AND day <= ?
     GROUP BY COALESCE(NULLIF(referrer, ''), '(direct)')
     ORDER BY views DESC LIMIT 8`
  ).bind(monthStart, today).all();
  const countryRows = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(country, ''), '??') AS country, COUNT(*) AS views,
            COUNT(DISTINCT visitor_hash) AS uniques
     FROM page_views WHERE day >= ? AND day <= ?
     GROUP BY COALESCE(NULLIF(country, ''), '??')
     ORDER BY views DESC LIMIT 12`
  ).bind(monthStart, today).all();
  const archive = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(date) AS latest FROM issues"
  ).first();
  return {
    todayLabel: formatLong(today).th,
    today: todayStats,
    week: weekStats,
    month: monthStats,
    daily,
    issues: (issueRows.results || []).map((row) => ({
      date: row.date,
      headline: row.headline || "",
      views: num(row.views),
      uniques: num(row.uniques),
    })),
    referrers: (referrerRows.results || []).map((row) => ({
      referrer: row.referrer,
      views: num(row.views),
    })),
    countries: (countryRows.results || []).map((row) => ({
      country: row.country,
      views: num(row.views),
      uniques: num(row.uniques),
    })),
    archiveCount: num(archive && archive.n),
    latestIssue: archive && archive.latest || "",
    lastSync: await getMeta(env, "last_sync_at"),
  };
}

function refreshInBackground(env, ctx) {
  ctx.waitUntil(maybeSync(env));
}

async function refreshAndWait(env, ctx) {
  const task = maybeSync(env);
  ctx.waitUntil(task);
  await Promise.race([task, sleep(20000)]);
}

function maybeSync(env) {
  if (syncInFlight) return syncInFlight;
  return track((async () => {
    if (await isFresh(env)) {
      return { ok: true, skipped: true, inserted: 0, updated: 0, unchanged: 0, remaining: num(await getMeta(env, "sync_remaining")), checked: 0, errors: [] };
    }
    return syncIssues(env);
  })().catch(asSyncError));
}

function runSync(env) {
  if (syncInFlight) return syncInFlight;
  return track(syncIssues(env).catch(asSyncError));
}

function track(promise) {
  const tracked = promise.finally(() => {
    if (syncInFlight === tracked) syncInFlight = null;
  });
  syncInFlight = tracked;
  return tracked;
}

function asSyncError(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ message: "sync failed", error: message }));
  return { ok: false, mode: "origin", error: message, inserted: 0, updated: 0, unchanged: 0, remaining: null, checked: 0, errors: [] };
}

async function isFresh(env) {
  if (await backoffActive(env)) return true;
  const now = Date.now();
  const success = Date.parse((await getMeta(env, "last_sync_at")) || "");
  const attempt = Date.parse((await getMeta(env, "last_sync_attempt")) || "");
  const remaining = num(await getMeta(env, "sync_remaining"));
  if (Number.isFinite(success)) {
    const windowMs = remaining > 0 ? 3000 : 120000;
    if (now - success < windowMs) return true;
  }
  if (Number.isFinite(attempt) && (!Number.isFinite(success) || attempt > success) && now - attempt < 30000) {
    return true;
  }
  return false;
}

async function readPushedIssues(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (!type.includes("application/json")) return null;
  const raw = await request.text();
  if (!raw.trim()) return null;
  if (raw.length > 2_000_000) throw new Error("sync body is too large");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("sync body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.issues)) {
    throw new Error("sync body needs an issues array");
  }
  if (parsed.issues.length > 40) throw new Error("sync at most 40 issues at once");
  return parsed.issues;
}

async function runDirectSync(env, issues) {
  if (syncInFlight) await syncInFlight.catch(() => {});
  if (syncInFlight) await syncInFlight.catch(() => {});
  const job = ingestPushed(env, issues).catch((error) => {
    const result = asSyncError(error);
    result.mode = "push";
    return result;
  });
  return track(job);
}

async function ingestPushed(env, issues) {
  const existing = await env.DB.prepare("SELECT date, content_hash, ingested_at FROM issues").all();
  const byDate = new Map((existing.results || []).map((row) => [row.date, row]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const errors = [];
  for (const item of issues) {
    let date = "";
    try {
      const pushed = normalizePushed(item);
      date = pushed.date;
      const outcome = await upsertBody(env, pushed.date, pushed.body, byDate.get(pushed.date), "push");
      if (outcome === "inserted") inserted++;
      else if (outcome === "updated") updated++;
      else unchanged++;
    } catch (error) {
      errors.push({
        date: date || String(item && item.date || ""),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const finished = new Date().toISOString();
  if (inserted + updated + unchanged > 0) {
    await setMeta(env, "last_direct_sync_at", finished);
    await setMeta(env, "last_sync_at", finished);
    await setMeta(env, "sync_remaining", "0");
    await clearBackoff(env);
  }
  const result = {
    ok: errors.length === 0,
    mode: "push",
    checked: issues.length,
    inserted,
    updated,
    unchanged,
    remaining: 0,
    errors,
  };
  console.log(JSON.stringify({
    message: "push sync complete",
    checked: result.checked,
    inserted,
    updated,
    unchanged,
    errors: errors.length,
  }));
  return result;
}

function normalizePushed(item) {
  if (!item || typeof item !== "object") throw new Error("issue entry is invalid");
  const date = String(item.date || "");
  if (!DATE_RE.test(date)) throw new Error("issue date is invalid");
  let body = item.body;
  if (typeof body !== "string") {
    if (item.content && typeof item.content === "object" && !Array.isArray(item.content)) {
      body = JSON.stringify(item.content);
    } else {
      throw new Error("issue body is missing");
    }
  }
  if (body.length > 500_000) throw new Error("issue body is too large");
  body = stripBom(body);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("issue JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("issue JSON is not an object");
  if (parsed.date && parsed.date !== date) throw new Error("issue date does not match body");
  return { date, body };
}

async function syncIssues(env) {
  if (await backoffActive(env)) {
    return skippedSync("backoff");
  }
  await setMeta(env, "last_sync_attempt", new Date().toISOString());
  if (await recentDirectPush(env)) {
    await setMeta(env, "last_sync_at", new Date().toISOString());
    await setMeta(env, "sync_remaining", "0");
    return skippedSync("direct-push-window");
  }
  let discovered;
  try {
    discovered = await discoverDates(env);
  } catch (error) {
    if (error && error.throttled) {
      await bumpBackoff(env);
      return {
        ok: false,
        throttled: true,
        mode: "origin",
        error: error.message,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        remaining: null,
        checked: 0,
        errors: [],
      };
    }
    throw error;
  }
  const existing = await env.DB.prepare("SELECT date, content_hash, ingested_at FROM issues").all();
  const byDate = new Map((existing.results || []).map((row) => [row.date, row]));
  const dates = discovered.dates;
  let seen = parseSeen(await getMeta(env, "sync_seen")).filter((date) => dates.includes(date));
  let queue = dates.filter((date) => !seen.includes(date));
  if (queue.length === 0) {
    seen = [];
    queue = dates.slice();
  }
  const batch = queue.slice(0, batchLimit(env));
  let inserted = 0;
  let updated = 0;
  let same = 0;
  const errors = [];
  const processed = [];
  let throttled = null;
  for (const date of batch) {
    try {
      const loaded = await loadIssueText(env, date, discovered.fallback.get(date));
      if (!loaded) {
        processed.push(date);
        same++;
        continue;
      }
      const outcome = await upsertBody(env, date, loaded.text, byDate.get(date), loaded.source);
      processed.push(date);
      if (outcome === "inserted") inserted++;
      else if (outcome === "updated") updated++;
      else same++;
    } catch (error) {
      if (error && error.throttled) {
        throttled = error;
        break;
      }
      errors.push({
        date,
        error: error instanceof Error ? error.message : String(error),
      });
      processed.push(date);
    }
  }
  seen = seen.concat(processed);
  const remaining = queue.filter((date) => !processed.includes(date)).length;
  await setMeta(env, "sync_seen", seen.join(","));
  await setMeta(env, "sync_remaining", String(remaining));
  if (throttled) {
    await bumpBackoff(env);
    return {
      ok: false,
      throttled: true,
      mode: "origin",
      error: throttled.message,
      checked: dates.length,
      inserted,
      updated,
      unchanged: same,
      remaining,
      errors,
    };
  }
  const finished = new Date().toISOString();
  await setMeta(env, "last_sync_at", finished);
  await clearBackoff(env);
  const result = {
    ok: errors.length === 0,
    mode: "origin",
    checked: dates.length,
    inserted,
    updated,
    unchanged: same + Math.max(0, dates.length - queue.length),
    remaining,
    errors,
  };
  console.log(JSON.stringify({
    message: "sync complete",
    checked: result.checked,
    inserted,
    updated,
    unchanged: result.unchanged,
    remaining,
    errors: errors.length,
  }));
  if (errors.length) {
    console.error(JSON.stringify({ message: "sync file errors", errors: errors.slice(0, 5) }));
  }
  return result;
}

function skippedSync(reason) {
  return {
    ok: true,
    skipped: true,
    mode: "origin",
    reason,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    remaining: 0,
    checked: 0,
    errors: [],
  };
}

async function discoverDates(env) {
  const dates = new Set();
  const rows = await env.DB.prepare("SELECT date FROM issues").all();
  for (const row of rows.results || []) {
    if (DATE_RE.test(row.date)) dates.add(row.date);
  }
  const fallback = new Map();
  const latest = await loadPublic(env, "/content/latest.json");
  if (latest) {
    try {
      const parsed = JSON.parse(stripBom(latest.text));
      if (parsed && DATE_RE.test(String(parsed.date || ""))) {
        dates.add(parsed.date);
        fallback.set(parsed.date, stripBom(latest.text));
      }
    } catch (error) {
      console.log(JSON.stringify({
        message: "latest.json was not an issue",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  const manifest = await loadPublic(env, "/content/manifest.json", false);
  if (manifest) {
    try {
      const parsed = JSON.parse(stripBom(manifest.text));
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.dates;
      if (Array.isArray(list)) {
        for (const date of list) {
          if (DATE_RE.test(String(date))) dates.add(String(date));
        }
      }
    } catch (error) {
      console.log(JSON.stringify({
        message: "manifest.json ignored",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return {
    dates: [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)),
    fallback,
  };
}

async function loadIssueText(env, date, fallback) {
  const loaded = await loadPublic(env, `/content/${date}.json`);
  if (loaded) return loaded;
  if (typeof fallback === "string") return { text: fallback, source: "pages" };
  return null;
}

async function loadPublic(env, pathname, allowRaw = true) {
  const pages = await fetchStatus(() => originFetch(env, pathname, ""));
  if (pages.throttled) throw pages.error;
  if (pages.ok) return { text: pages.text, source: "pages" };
  if (!allowRaw) return null;
  const raw = await fetchStatus(() => upstreamFetch(rawUrlFor(env, pathname.replace(/^\/+/, "")), plainHeaders()));
  if (raw.throttled) throw raw.error;
  if (raw.ok) return { text: raw.text, source: "raw" };
  return null;
}

async function fetchStatus(run) {
  let response;
  try {
    response = await run();
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error));
    wrapped.throttled = true;
    return { throttled: true, error: wrapped };
  }
  if (response.status === 404 || response.status === 410) {
    await discard(response);
    return { ok: false };
  }
  if (response.status === 429 || response.status === 403 || response.status >= 500) {
    const detail = (await response.text()).slice(0, 160);
    const error = new Error(`upstream ${response.status} ${detail}`.trim());
    error.throttled = true;
    return { throttled: true, error };
  }
  if (!response.ok) {
    await discard(response);
    return { ok: false };
  }
  return { ok: true, text: await response.text() };
}

async function discard(response) {
  try {
    if (response.body && typeof response.body.cancel === "function") await response.body.cancel();
    else await response.arrayBuffer();
  } catch {
    // The status is already known; a failed cancel should not turn a 404 into a retry storm.
  }
}

async function upsertBody(env, date, body, prev, source) {
  body = stripBom(body);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("issue JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("issue JSON is not an object");
  const hash = await sha256Hex(body);
  const now = new Date().toISOString();
  const headline = headlineOf(parsed).slice(0, 500);
  const tagline = String(parsed.tagline || "").slice(0, 500);
  const issueNo = issueNumber(parsed);
  await env.DB.prepare(
    `INSERT INTO issues (date, issue_no, headline, tagline, content, content_hash, source_sha, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       issue_no = excluded.issue_no,
       headline = excluded.headline,
       tagline = excluded.tagline,
       content = excluded.content,
       content_hash = excluded.content_hash,
       source_sha = excluded.source_sha,
       updated_at = CASE
         WHEN issues.content_hash != excluded.content_hash THEN excluded.updated_at
         ELSE issues.updated_at
       END`
  ).bind(date, issueNo, headline, tagline, body, hash, source, now, now).run();
  if (!prev) return "inserted";
  if (prev.content_hash !== hash) return "updated";
  return "unchanged";
}

async function recentDirectPush(env) {
  const at = Date.parse((await getMeta(env, "last_direct_sync_at")) || "");
  return Number.isFinite(at) && Date.now() - at < DIRECT_PUSH_WINDOW_MS;
}

async function backoffActive(env) {
  const until = Date.parse((await getMeta(env, "sync_backoff_until")) || "");
  return Number.isFinite(until) && until > Date.now();
}

async function bumpBackoff(env) {
  const count = Math.min(num(await getMeta(env, "sync_fail_count")) + 1, 8);
  const delay = Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** (count - 1));
  await setMeta(env, "sync_fail_count", String(count));
  await setMeta(env, "sync_backoff_until", new Date(Date.now() + delay).toISOString());
}

async function clearBackoff(env) {
  await setMeta(env, "sync_fail_count", "0");
  await setMeta(env, "sync_backoff_until", "");
}

function parseSeen(value) {
  if (!value) return [];
  return String(value).split(",").map((date) => date.trim()).filter((date) => DATE_RE.test(date));
}

function rawUrlFor(env, path) {
  const raw = trimSlash(env.GITHUB_RAW_BASE || DEFAULT_RAW);
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${raw}/${repoOf(env)}/${encodeURIComponent(refOf(env))}/${encoded}`;
}

async function proxyAsset(env, pathname, search) {
  try {
    const upstream = await originFetch(env, pathname, search);
    const headers = new Headers();
    const type = upstream.headers.get("content-type");
    if (type) headers.set("content-type", type);
    else headers.set("content-type", guessType(pathname));
    headers.set("cache-control", assetCache(pathname));
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.error(JSON.stringify({
      message: "asset proxy failed",
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return text("Origin unavailable", 502);
  }
}

async function originFetch(env, pathname, search) {
  const target = originUrl(env, pathname, search);
  return upstreamFetch(target, plainHeaders());
}

function originUrl(env, pathname, search) {
  const base = trimSlash(env.ORIGIN_BASE || DEFAULT_ORIGIN) + "/";
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") throw new Error("bad origin");
  const relative = pathname.replace(/^\/+/, "") + (search || "");
  const url = new URL(relative, baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new Error("bad path");
  }
  return url.toString();
}

function plainHeaders() {
  return {
    Accept: "*/*",
    "User-Agent": "nadda-daily-worker",
    "Cache-Control": "no-cache",
  };
}

async function upstreamFetch(url, headers) {
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    headers,
  });
}

function noteView(ctx, env, request, url) {
  if (request.method !== "GET") return;
  ctx.waitUntil(recordView(env, request, url));
}

async function recordView(env, request, url) {
  try {
    if (!isPageView(url.pathname) || isBot(request)) return;
    const dest = request.headers.get("Sec-Fetch-Dest");
    if (dest && dest !== "document") return;
    const purpose = `${request.headers.get("Purpose") || ""} ${request.headers.get("Sec-Purpose") || ""}`;
    if (/prefetch/i.test(purpose)) return;
    const day = bangkokDay();
    const issueDate = issueDateFromUrl(url, day);
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const ua = (request.headers.get("User-Agent") || "").slice(0, 300);
    const salt = env.VISITOR_SALT || env.ADMIN_PASSWORD || "nadda-daily";
    const visitorHash = await sha256Hex(`${ip}\n${ua}\n${day}\n${salt}`);
    const country = String((request.cf && request.cf.country) || request.headers.get("CF-IPCountry") || "").slice(0, 8);
    await env.DB.prepare(
      `INSERT INTO page_views (path, issue_date, viewed_at, day, country, referrer, visitor_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      storedPath(url),
      issueDate,
      new Date().toISOString(),
      day,
      country,
      cleanReferrer(request.headers.get("Referer")),
      visitorHash,
    ).run();
  } catch (error) {
    console.error(JSON.stringify({
      message: "view record failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function isPageView(pathname) {
  if (pathname.startsWith("/admin")) return false;
  if (pathname === "/" || pathname === "/index.html" || pathname === "/archive" || pathname === "/archive/") return true;
  return /^\/issue\/\d{4}-\d{2}-\d{2}\/?$/.test(pathname);
}

function isBot(request) {
  const ua = request.headers.get("User-Agent") || "";
  if (!ua || BOT_RE.test(ua)) return true;
  const cf = request.cf;
  if (cf && cf.botManagement && (cf.botManagement.verifiedBot || cf.botManagement.score === 1)) return true;
  return false;
}

function storedPath(url) {
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const date = url.searchParams.get("date");
    if (date && DATE_RE.test(date)) return `/?date=${date}`;
    return "/";
  }
  return url.pathname.replace(/\/$/, "") || "/";
}

function issueDateFromUrl(url, today) {
  const pathMatch = url.pathname.match(/^\/issue\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (pathMatch) return pathMatch[1];
  const queryDate = url.searchParams.get("date");
  if (queryDate && DATE_RE.test(queryDate)) return queryDate;
  if (url.pathname === "/" || url.pathname === "/index.html") return today;
  return null;
}

function cleanReferrer(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`.slice(0, 300);
  } catch {
    return "";
  }
}

async function canSync(request, env) {
  const header = request.headers.get("Authorization") || "";
  const bearer = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim().slice(0, 200) : "";
  const alt = (request.headers.get("X-Sync-Token") || "").trim().slice(0, 200);
  if (env.SYNC_TOKEN && (await fixedEqual(bearer, env.SYNC_TOKEN) || (alt && await fixedEqual(alt, env.SYNC_TOKEN)))) {
    return true;
  }
  return isAdmin(request, env);
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const raw = readCookie(request.headers.get("Cookie"), "nd_session");
  const parts = raw.split(".");
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!/^\d{10,12}$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.ADMIN_PASSWORD, exp);
  return fixedEqual(sig, expected);
}

function readCookie(header, name) {
  if (!header) return "";
  for (const part of header.split(/; */)) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index) === name) {
      try {
        return decodeURIComponent(part.slice(index + 1));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function sessionCookie(value, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const body = value ? encodeURIComponent(value) : "";
  return `nd_session=${body}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

async function fixedEqual(provided, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(provided))),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(digest);
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headlineOf(issue) {
  const groups = [issue.thailand, issue.world, issue.social];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const lead = group.find((item) => item && item.lead && item.title);
    if (lead) return String(lead.title);
  }
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const first = group.find((item) => item && item.title);
    if (first) return String(first.title);
  }
  return String(issue.tagline || "");
}

function issueNumber(issue) {
  const value = Number(issue.issue_no);
  return Number.isInteger(value) ? value : null;
}

function batchLimit(env) {
  const value = Number(env.SYNC_BATCH_LIMIT);
  if (!Number.isFinite(value) || value <= 0) return 20;
  return Math.min(20, Math.floor(value));
}

function repoOf(env) {
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("invalid GITHUB_REPO");
  return repo;
}

function refOf(env) {
  const ref = env.GITHUB_REF || DEFAULT_REF;
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(ref) || ref.includes("..")) throw new Error("invalid GITHUB_REF");
  return ref;
}

async function getMeta(env, key) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

function bangkokDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(iso, delta) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function formatLong(iso) {
  const date = new Date(`${iso}T00:00:00+07:00`);
  return {
    en: new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok",
    }).format(date),
    th: new Intl.DateTimeFormat("th-TH", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok",
    }).format(date),
  };
}

function shortDay(iso) {
  const date = new Date(`${iso}T00:00:00+07:00`);
  return new Intl.DateTimeFormat("th-TH", {
    day: "numeric", month: "short", timeZone: "Asia/Bangkok",
  }).format(date);
}

function countryName(code) {
  if (!code || code === "??") return "ไม่ทราบ";
  try {
    return new Intl.DisplayNames(["th"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

function fmt(value) {
  return new Intl.NumberFormat("th-TH").format(num(value));
}

function num(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intParam(url, key) {
  const parsed = Number(url.searchParams.get(key));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(1000000, Math.trunc(parsed));
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function assetCache(pathname) {
  if (pathname.endsWith(".html") || pathname.endsWith(".json") || pathname === "/index.html") return "no-cache";
  return "public, max-age=60";
}

function guessType(pathname) {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function jsonHeaders(cache) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders("no-store") });
}

function text(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function htmlResponse(body, status, cache = "no-store", admin = false) {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "referrer-policy": admin ? "no-referrer" : "strict-origin-when-cross-origin",
  };
  if (admin) {
    headers["x-frame-options"] = "DENY";
    headers["x-robots-tag"] = "noindex";
  }
  return new Response(body, { status, headers });
}

function errorPage(message, status) {
  return shell("The Nadda Daily", `<p class="loading">${esc(message)}</p><p class="center"><a href="/">หน้าแรก</a></p>`, status >= 500);
}

function shell(title, body, admin, canonicalPath) {
  const canonical = canonicalPath
    ? `<link rel="canonical" href="https://daily.natlada.com${canonicalPath}">`
    : "";
  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${canonical}
${admin ? '<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="/favicon-32.png">
<base href="/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:opsz,wght@6..96,500&family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=Noto+Serif+Thai:wght@300;400&display=swap">
<link rel="stylesheet" href="/style.css">
<style>
.archive-list{list-style:none;padding:0;margin:0}
.archive-list a{display:grid;grid-template-columns:1fr;gap:2px;padding:12px 0;border-top:.5px solid var(--rule);color:inherit;text-decoration:none}
.archive-list .when{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft)}
.archive-list .when .th{display:block;letter-spacing:0;text-transform:none;font-size:14px}
.archive-list .hed{font:400 28px/1.15 "Bodoni Moda",serif}
.archive-list .no{color:var(--soft);font-size:13px;letter-spacing:.12em;text-transform:uppercase}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:8px 0 18px}
.card{border:.5px solid var(--rule);padding:12px}
.card .n{font:400 42px/1 "Bodoni Moda",serif}
.card .l,.card .sub,.note,.sub{color:var(--soft)}
.card .l{font-size:12px;letter-spacing:.16em;text-transform:uppercase}
.note{font-size:15px}
.bar{display:flex;align-items:center;gap:8px;margin:2px 0;font-size:14px}
.bar .lbl{width:4.5em;color:var(--soft)}
.bar .track{flex:1;height:7px;background:#e9e3d6}
.bar .fill{display:block;height:100%;background:#1d1c1a}
.bar .num{width:5.5em;text-align:right}
.bar .u{color:var(--soft)}
table.plain{width:100%;border-collapse:collapse}
table.plain td,table.plain th{border-top:.5px solid #ddd;padding:6px 8px 6px 0;text-align:left;vertical-align:top;font-weight:400}
.login label{display:block;margin:12px 0}
.login input{font:400 20px "Cormorant Garamond",serif;padding:8px;width:min(100%,320px);border:.5px solid var(--ink);background:transparent;color:inherit}
.tools{display:inline-block;margin-right:8px}
.warn{color:#8a3b32}
.banner{border:.5px solid var(--rule);padding:8px 10px}
a{color:inherit}
</style></head><body><main class="paper">${body}</main></body></html>`;
}
