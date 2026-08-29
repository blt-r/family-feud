import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../src/client/App.svelte", import.meta.url), "utf8");
const host = fs.readFileSync(new URL("../src/client/HostPage.svelte", import.meta.url), "utf8");
const display = fs.readFileSync(new URL("../src/client/DisplayPage.svelte", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("host secrets are claimed from fragments rather than WebSocket query strings", () => {
  assert.match(app, /hashParams\.get\("token"\)/);
  assert.match(app, /\/claim/);
  assert.doesNotMatch(app, /socket\?role=\$\{role\}.*token=/);
});

test("the app uses a targeted live region", () => {
  assert.doesNotMatch(html, /<main[^>]+aria-live/);
  assert.match(app, /role="status" aria-live="polite"/);
});

test("narrow audience layouts retain two answer columns", () => {
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.answer-board \{ grid-template-columns: repeat\(2,/);
});

test("host links use the clean route", () => {
  assert.match(display, /href="\/host"/);
  assert.match(host, /`\/host\?room=/);
  assert.doesNotMatch(`${app}${host}${display}`, /\/host\.html/);
});

test("team names submit on Enter as well as blur", () => {
  assert.match(host, /onkeydown=\{submitTeamNameOnEnter\}/);
  assert.match(host, /event\.key !== "Enter"/);
  assert.match(host, /event\.currentTarget\.blur\(\)/);
});
