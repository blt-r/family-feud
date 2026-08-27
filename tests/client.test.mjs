import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = ["index.html", "host.html"].map((name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));

test("host secrets are claimed from fragments rather than WebSocket query strings", () => {
  assert.match(app, /hashParams\.get\("token"\)/);
  assert.match(app, /\/claim/);
  assert.doesNotMatch(app, /socket\?role=\$\{role\}.*token=/);
});

test("the app uses a targeted live region", () => {
  for (const page of html) {
    assert.doesNotMatch(page, /<main[^>]+aria-live/);
    assert.match(page, /id="status-region"[^>]+aria-live="polite"/);
  }
});

test("narrow audience layouts retain two answer columns", () => {
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.answer-board \{ grid-template-columns: repeat\(2,/);
});
