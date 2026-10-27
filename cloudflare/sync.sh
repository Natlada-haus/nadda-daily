#!/usr/bin/env bash
# Push every dated issue in this checkout to POST /admin/sync.
# The Worker stores the JSON directly. It does not call the GitHub API.
set -euo pipefail

url="${SYNC_URL:-https://daily.natlada.com/admin/sync}"
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${SYNC_TOKEN:-}" ]; then
  echo "SYNC_TOKEN is not set" >&2
  exit 1
fi

SYNC_URL="$url" REPO_ROOT="$root" node --input-type=module <<'EOF'
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.REPO_ROOT;
const url = process.env.SYNC_URL;
const names = (await readdir(path.join(root, "content")))
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .sort();
const issues = [];
for (const name of names) {
  const body = await readFile(path.join(root, "content", name), "utf8");
  const date = name.slice(0, 10);
  const parsed = JSON.parse(body);
  if (parsed.date && parsed.date !== date) {
    console.error(`${name} date field is ${parsed.date}`);
    process.exit(1);
  }
  issues.push({ date, body });
}

let inserted = 0;
let updated = 0;
let unchanged = 0;
for (let i = 0; i < issues.length; i += 20) {
  const chunk = issues.slice(i, i + 20);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SYNC_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ issues: chunk }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error(text.slice(0, 500));
    process.exit(1);
  }
  if (!response.ok || payload.ok === false) {
    console.error(text.slice(0, 500));
    process.exit(1);
  }
  if (payload.mode !== "push") {
    console.error("Worker did not accept the pushed issues. Redeploy cloudflare/dist/worker.js, then rerun this workflow.");
    process.exit(1);
  }
  console.log(text);
  inserted += payload.inserted || 0;
  updated += payload.updated || 0;
  unchanged += payload.unchanged || 0;
}
console.log(JSON.stringify({
  ok: true,
  mode: "push",
  checked: issues.length,
  inserted,
  updated,
  unchanged,
  remaining: 0,
}));
EOF
