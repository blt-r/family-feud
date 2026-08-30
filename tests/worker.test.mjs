import assert from "node:assert/strict";
import test from "node:test";
import worker, { GameRoom, RoomCreationLimiter, normalizeQuestionKey, pickQuestionSet } from "../src/worker.js";

const TEST_QUESTIONS = [
  {
    id: "test-one",
    prompt: "Name a test answer.",
    familyFriendly: true,
    answers: [
      { text: "First", points: 50 },
      { text: "Second", points: 30 },
      { text: "Third", points: 20 }
    ]
  },
  {
    id: "test-two",
    prompt: "Name another test answer.",
    familyFriendly: true,
    answers: [
      { text: "Alpha", points: 45 },
      { text: "Beta", points: 35 },
      { text: "Gamma", points: 20 }
    ]
  }
];

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.flatMap((item) => this.values.has(item) ? [[item, this.values.get(item)]] : []));
    return this.values.get(key);
  }
  async put(key, value) {
    if (typeof key === "object") for (const [name, entry] of Object.entries(key)) this.values.set(name, entry);
    else this.values.set(key, value);
  }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async deleteAll() { this.values.clear(); }
}

function context(values = {}) {
  const sockets = [];
  return {
    storage: new MemoryStorage(values),
    blockConcurrencyWhile: (callback) => callback(),
    getTags: (socket) => socket.tags || [],
    getWebSockets: () => sockets,
    acceptWebSocket: (socket, tags) => { socket.tags = tags; sockets.push(socket); }
  };
}

const env = { ASSETS: { fetch: async () => Response.json(TEST_QUESTIONS) } };

test("room creation fails clearly when the question library is unavailable", async (t) => {
  t.mock.method(console, "error", () => {});
  const unavailableEnv = {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    GAME_ROOMS: { idFromName: () => { throw new Error("Room allocation should not run"); } }
  };
  const response = await worker.fetch(new Request("https://example.com/api/rooms", { method: "POST", body: "{}" }), unavailableEnv);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "The question library is unavailable. Please try again." });
});

test("new rooms receive four-character codes", async () => {
  let initializedCode;
  const createEnv = {
    ASSETS: env.ASSETS,
    GAME_ROOMS: {
      idFromName: (code) => code,
      get: () => ({
        fetch: async (_request, init) => {
          initializedCode = JSON.parse(init.body).code;
          return new Response(null, { status: 201 });
        }
      })
    }
  };
  const response = await worker.fetch(new Request("https://example.com/api/rooms", { method: "POST", body: "{}" }), createEnv);
  const result = await response.json();
  assert.match(result.code, /^[A-Z0-9]{4}$/);
  assert.equal(initializedCode, result.code);
});

test("the clean host route serves the host page asset", async () => {
  let assetURL;
  const routeEnv = { ASSETS: { fetch: async (request) => {
    assetURL = new URL(request.url);
    return new Response("host page");
  } } };
  const response = await worker.fetch(new Request("https://example.com/host?room=ABCD"), routeEnv);
  assert.equal(response.status, 200);
  assert.equal(assetURL.pathname, "/index.html");
  assert.equal(assetURL.search, "?room=ABCD");
});

test("question selection removes normalized duplicates and respects family mode", () => {
  const duplicate = { ...TEST_QUESTIONS[0], id: "duplicate", prompt: `${TEST_QUESTIONS[0].prompt.toUpperCase()}!` };
  const blocked = { ...TEST_QUESTIONS[1], id: "blocked", prompt: "A unique blocked prompt", familyFriendly: false };
  const selected = pickQuestionSet([...TEST_QUESTIONS, duplicate, blocked], true);
  const keys = selected.map((question) => normalizeQuestionKey(question.prompt));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(selected.some((question) => question.id === "blocked"), false);
});

test("malformed team counts cannot corrupt room state", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "team-count", count: "not-a-number" }), false);
  assert.equal(room.state.teams.length, 2);
});

test("team defaults are consistent and removed team names are restored", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.deepEqual(room.state.teams.map((team) => team.name), ["Team 1", "Team 2"]);
  assert.equal(await room.applyAction({ type: "team-count", count: 4 }), true);
  assert.deepEqual(room.state.teams.map((team) => team.name), ["Team 1", "Team 2", "Team 3", "Team 4"]);
  assert.equal(await room.applyAction({ type: "rename-team", index: 3, name: "Cousins" }), true);
  assert.equal(await room.applyAction({ type: "team-count", count: 2 }), true);
  assert.equal(await room.applyAction({ type: "team-count", count: 4 }), true);
  assert.equal(room.state.teams[3].name, "Cousins");
});

test("events use a monotonic sequence even inside one millisecond", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  await room.applyAction({ type: "sound", name: "intro" });
  const first = room.state.eventSequence;
  await room.applyAction({ type: "sound", name: "round-win" });
  assert.equal(room.state.eventSequence, first + 1);
  assert.equal(room.state.lastEvent.sequence, first + 1);
  await room.applyAction({ type: "sound", name: "stop" });
  assert.equal(room.state.eventSequence, first + 2);
  assert.equal(room.state.lastEvent.name, "stop");
});

test("the host can toggle the intermission display", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(room.publicState(false).intermissionVisible, true);
  assert.equal(await room.applyAction({ type: "intermission-visibility", visible: false }), true);
  assert.equal(room.publicState(false).intermissionVisible, false);
  assert.equal(await room.applyAction({ type: "intermission-visibility", visible: false }), false);
  assert.equal(await room.applyAction({ type: "intermission-visibility", visible: true }), true);
});

test("the first hibernation-delivered host action waits for state loading", async () => {
  const savedRoom = new GameRoom(context(), env);
  await savedRoom.ready;
  const state = savedRoom.initialState("ABCD", TEST_QUESTIONS);
  const ctx = context({ state, hostToken: "a".repeat(32) });
  const room = new GameRoom(ctx, env);
  const messages = [];
  const socket = {
    tags: ["host"],
    deserializeAttachment: () => ({ role: "host" }),
    send: (message) => messages.push(JSON.parse(message))
  };
  await room.webSocketMessage(socket, JSON.stringify({ type: "strike" }));
  assert.equal(room.state.teams[0].strikes, 1);
  assert.equal(room.state.eventSequence, 1);
  assert.equal(messages.some((message) => message.type === "action-error"), false);
});

test("public state hides unrevealed prompts and answers", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  const state = room.publicState(false);
  assert.equal(state.question.prompt, null);
  assert.equal(state.question.answers[0].text, null);
});

test("scoring applies the multiplier and awards the bank once", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "multiplier", value: 2 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(room.state.roundBank, TEST_QUESTIONS[0].answers[0].points * 2);
  assert.equal(await room.applyAction({ type: "award", index: 1 }), true);
  assert.equal(room.state.teams[1].score, TEST_QUESTIONS[0].answers[0].points * 2);
  assert.equal(room.state.roundBank, 0);
  assert.equal(await room.applyAction({ type: "award", index: 1 }), false);
});

test("existing rooms reject a colliding initialization", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  const response = await room.fetch(new Request("https://room.internal/init", { method: "POST", body: "{}" }));
  assert.equal(response.status, 409);
});

test("host claims create an HttpOnly cookie and unlock host state", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  room.hostToken = "a".repeat(32);
  const claim = await room.fetch(new Request("https://example.com/api/rooms/ABCD/claim", { method: "POST", headers: { authorization: `Bearer ${room.hostToken}` } }));
  const cookie = claim.headers.get("set-cookie");
  assert.equal(claim.status, 204);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  const state = await room.fetch(new Request("https://example.com/api/rooms/ABCD/state?role=host", { headers: { cookie: cookie.split(";")[0] } }));
  assert.equal(state.status, 200);
  assert.equal(Boolean((await state.json()).question.prompt), true);
});

test("room creation limiter rejects excessive attempts", async () => {
  const ctx = context();
  const limiter = new RoomCreationLimiter(ctx);
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await limiter.fetch(new Request("https://limiter.internal/check", { method: "POST" }))).status, 204);
  }
  assert.equal((await limiter.fetch(new Request("https://limiter.internal/check", { method: "POST" }))).status, 429);
});
