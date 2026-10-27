import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

describe("github pages redirect", () => {
  it("sends github.io paths to the same page on daily.natlada.com", async () => {
    const script = await readFile(path.join(root, "redirect.js"), "utf8");
    const index = await readFile(path.join(root, "index.html"), "utf8");
    const missing = await readFile(path.join(root, "404.html"), "utf8");
    assert.match(index, /src="redirect\.js"/);
    assert.match(index, /rel="canonical" href="https:\/\/daily\.natlada\.com\/"/);
    assert.match(missing, /src="https:\/\/natlada-haus\.github\.io\/nadda-daily\/redirect\.js"/);
    assert.doesNotMatch(script, /meta http-equiv/i);

    const run = (hostname, pathname, search = "", hash = "") => {
      const link = {
        href: "",
        setAttribute(name, value) { if (name === "href") this.href = value; },
      };
      let replaced = null;
      vm.runInNewContext(script, {
        location: {
          hostname,
          pathname,
          search,
          hash,
          replace(url) { replaced = url; },
        },
        document: {
          querySelector() { return link; },
        },
      });
      return { replaced, canonical: link.href };
    };

    const home = run("natlada-haus.github.io", "/nadda-daily/", "", "");
    assert.equal(home.replaced, "https://daily.natlada.com/");
    assert.equal(home.canonical, "https://daily.natlada.com/");

    const issue = run("natlada-haus.github.io", "/nadda-daily/issue/2026-10-27", "?x=1", "#paper");
    assert.equal(issue.replaced, "https://daily.natlada.com/issue/2026-10-27?x=1#paper");
    assert.equal(issue.canonical, "https://daily.natlada.com/issue/2026-10-27?x=1");

    const archive = run("natlada-haus.github.io", "/nadda-daily/archive", "", "");
    assert.equal(archive.replaced, "https://daily.natlada.com/archive");

    const dated = run("natlada-haus.github.io", "/nadda-daily/", "?date=2026-10-13", "");
    assert.equal(dated.replaced, "https://daily.natlada.com/?date=2026-10-13");

    const live = run("daily.natlada.com", "/issue/2026-10-27", "", "");
    assert.equal(live.replaced, null);
    assert.equal(live.canonical, "https://daily.natlada.com/issue/2026-10-27");

    const lookalike = run("github.io.evil.example", "/nadda-daily/", "", "");
    assert.equal(lookalike.replaced, null);
  });
});