import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../src/client/App.svelte", import.meta.url), "utf8");
const host = fs.readFileSync(new URL("../src/client/HostPage.svelte", import.meta.url), "utf8");
const display = fs.readFileSync(new URL("../src/client/DisplayPage.svelte", import.meta.url), "utf8");
const room = fs.readFileSync(new URL("../src/client/room.svelte.js", import.meta.url), "utf8");
const toast = fs.readFileSync(new URL("../src/client/Toast.svelte", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("host secrets are claimed from fragments rather than WebSocket query strings", () => {
  assert.match(host, /hashParams\.get\("token"\)/);
  assert.match(host, /\/claim/);
  assert.doesNotMatch(`${app}${host}${display}${room}`, /socket\?role=.*token=/);
});

test("the app uses a targeted live region", () => {
  assert.doesNotMatch(html, /<main[^>]+aria-live/);
  assert.match(toast, /role="status" aria-live="polite"/);
});

test("page components own page state and document titles", () => {
  assert.doesNotMatch(app, /\$state|<svelte:head>/);
  assert.match(host, /<svelte:head>[\s\S]*Family Feud — Host/);
  assert.match(display, /<svelte:head>[\s\S]*Family Feud — Game Board/);
  assert.match(room, /export class RoomConnection/);
});

test("narrow audience layouts retain two answer columns", () => {
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.answer-board \{ grid-template-columns: repeat\(2,/);
});

test("host links use the clean route", () => {
  assert.match(display, /href="\/host"/);
  assert.match(host, /href="\/">Join an existing game/);
  assert.match(host, /`\/host\?room=/);
  assert.doesNotMatch(`${app}${host}${display}`, /\/host\.html/);
});

test("team names submit on Enter as well as blur", () => {
  assert.match(host, /onkeydown=\{submitTeamNameOnEnter\}/);
  assert.match(host, /event\.key !== "Enter"/);
  assert.match(host, /event\.currentTarget\.blur\(\)/);
});

test("the audience display accepts exactly four-character room codes", () => {
  assert.match(display, /\^\[A-Z0-9\]\{4\}\$/);
  assert.match(display, /minlength="4" maxlength="4"/);
  assert.match(display, /Four-character room code/);
});
