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
  assert.equal(room.publicState(true).teams[0].strikes, 1);
  assert.equal(room.state.eventSequence, 1);
  assert.equal(messages.some((message) => message.type === "action-error"), false);
});

test("rooms with an incompatible beta schema reset instead of crashing", async () => {
  const seed = new GameRoom(context(), env);
  await seed.ready;
  const incompatibleState = seed.initialState("ABCD", TEST_QUESTIONS);
  delete incompatibleState.schemaVersion;
  delete incompatibleState.allocations;
  incompatibleState.roundBank = 50;
  incompatibleState.revealed = [0];
  incompatibleState.teams[0].score = 50;
  const ctx = context({ state: incompatibleState, hostToken: "a".repeat(32) });
  const room = new GameRoom(ctx, env);
  await room.ready;
  assert.equal(room.state.schemaVersion, 3);
  assert.deepEqual(room.state.allocations, []);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(room.publicState(true).teams[0].score, 0);
  assert.equal((await ctx.storage.get("state")).schemaVersion, 3);
});

test("public state hides unrevealed prompts and answers", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  const state = room.publicState(false);
  assert.equal(state.question.prompt, null);
  assert.equal(state.question.answers[0].text, null);
});

test("answers can be revealed without creating a scoring allocation", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "reveal-only", index: 0 }), true);
  assert.deepEqual(room.state.allocations[0].owner, { type: "unscored" });
  assert.equal(room.publicState(true).question.answers[0].revealed, true);
  assert.deepEqual(room.publicState(true).question.answers[0].owner, { type: "unscored" });
  assert.equal(room.publicState(false).question.answers[0].owner, undefined);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), false);
  assert.equal(await room.applyAction({ type: "multiplier", value: 3 }), true);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(await room.applyAction({ type: "hide-answer", index: 0 }), true);
  assert.equal(room.publicState(true).question.answers[0].revealed, false);
});

test("answer allocations are the source of truth for bank and team totals", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "multiplier", value: 2 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.deepEqual(room.state.allocations[0], {
    roundId: 1,
    questionId: "test-one",
    question: "Name a test answer.",
    answerIndex: 0,
    answer: "First",
    basePoints: 50,
    multiplier: 2,
    owner: { type: "bank" },
    awardId: null
  });
  assert.equal("roundBank" in room.state, false);
  assert.equal("score" in room.state.teams[0], false);
  assert.equal(room.publicState(true).roundBank, 100);
  assert.equal(await room.applyAction({ type: "award", index: 1 }), true);
  assert.deepEqual(room.state.allocations[0].owner, { type: "team", teamIndex: 1 });
  assert.equal(room.publicState(true).teams[1].score, 100);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(await room.applyAction({ type: "award", index: 1 }), false);
});

test("changing the multiplier recalculates the bank and every team in the current round", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 2 }), true);
  assert.equal(await room.applyAction({ type: "multiplier", value: 3 }), true);
  const state = room.publicState(true);
  assert.equal(state.teams[0].score, 150);
  assert.equal(state.teams[1].score, 90);
  assert.equal(state.roundBank, 60);
  assert.deepEqual(room.state.allocations.map((allocation) => allocation.multiplier), [3, 3, 3]);
  assert.equal(state.lastAward.points, 90);
});

test("switching questions restores the complete round state", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "multiplier", value: 2 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "active-team", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "strike" }), true);
  assert.equal(await room.applyAction({ type: "question-visibility", visible: true }), true);
  assert.equal(await room.applyAction({ type: "question", index: 1 }), true);
  assert.equal(room.state.allocations.length, 2);
  assert.equal(room.publicState(true).teams[0].score, 100);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(room.publicState(true).multiplier, 1);
  assert.equal(room.publicState(true).activeTeam, 0);
  assert.equal(room.publicState(true).teams[1].strikes, 0);
  assert.equal(room.publicState(true).questionVisible, false);
  assert.equal(await room.applyAction({ type: "multiplier", value: 3 }), true);
  assert.equal(room.publicState(true).teams[0].score, 100);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), true);
  assert.equal(room.publicState(true).teams[0].score, 235);
  assert.equal(await room.applyAction({ type: "question", index: 0 }), true);
  const restored = room.publicState(true);
  assert.equal(restored.multiplier, 2);
  assert.equal(restored.activeTeam, 1);
  assert.equal(restored.teams[1].strikes, 1);
  assert.equal(restored.questionVisible, true);
  assert.equal(restored.roundBank, 60);
  assert.deepEqual(restored.question.answers.map((answer) => answer.revealed), [true, true, false]);
  assert.deepEqual(restored.lastAward, { team: 0, points: 100 });
  assert.equal(await room.applyAction({ type: "multiplier", value: 3 }), true);
  assert.equal(room.publicState(true).roundBank, 90);
  assert.equal(room.publicState(true).teams[0].score, 285);
  assert.deepEqual(room.state.allocations.map(({ questionId, answer, multiplier }) => ({ questionId, answer, multiplier })), [
    { questionId: "test-one", answer: "First", multiplier: 3 },
    { questionId: "test-one", answer: "Second", multiplier: 3 },
    { questionId: "test-two", answer: "Alpha", multiplier: 3 }
  ]);
});

test("reloading questions keeps old round allocations but creates inaccessible new rounds", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 1 }), true);
  const oldRoundIds = [...room.state.questionRoundIds];
  const oldQuestions = room.state.questions;
  assert.equal(await room.applyAction({ type: "refresh-questions" }), true);
  assert.equal(room.state.allocations.length, 2);
  assert.equal(room.publicState(true).teams[0].score, 50);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(room.publicState(true).question.answers.some((answer) => answer.revealed), false);
  assert.equal(room.state.questionRoundIds.some((roundId) => oldRoundIds.includes(roundId)), false);
  assert.equal(oldRoundIds.every((roundId) => room.state.rounds[roundId]), true);
  assert.deepEqual(room.state.archivedQuestionSets, [{ questions: oldQuestions, questionRoundIds: oldRoundIds }]);
});

test("revealed answers can be removed and revealed again", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "multiplier", value: 2 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(room.publicState(true).roundBank, 100);
  assert.equal(await room.applyAction({ type: "multiplier", value: 3 }), true);
  assert.equal(await room.applyAction({ type: "hide-answer", index: 0 }), true);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.equal(room.publicState(true).question.answers[0].revealed, false);
  assert.equal(room.state.allocations.length, 0);
  assert.equal(await room.applyAction({ type: "hide-answer", index: 0 }), false);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(room.publicState(true).roundBank, 150);
  assert.equal(room.state.allocations[0].multiplier, 3);
});

test("undoing the latest award moves its allocations back to the bank", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "multiplier", value: 2 }), true);
  assert.equal(room.publicState(true).teams[1].score, 160);
  assert.equal(room.publicState(false).lastAward, undefined);
  assert.deepEqual(room.publicState(true).lastAward, { team: 1, points: 160 });
  assert.equal(await room.applyAction({ type: "undo-award" }), true);
  assert.equal(room.publicState(true).teams[1].score, 0);
  assert.equal(room.publicState(true).roundBank, 160);
  assert.equal(room.publicState(true).lastAward, null);
  assert.deepEqual(room.state.allocations.map(({ owner, awardId }) => ({ owner, awardId })), [
    { owner: { type: "bank" }, awardId: null },
    { owner: { type: "bank" }, awardId: null }
  ]);
  assert.equal(await room.applyAction({ type: "undo-award" }), false);
});

test("removing an awarded answer changes the derived team score and award value", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), true);
  const remainingPoints = TEST_QUESTIONS[0].answers[1].points;
  assert.equal(await room.applyAction({ type: "hide-answer", index: 0 }), true);
  assert.equal(room.publicState(true).teams[0].score, remainingPoints);
  assert.equal(room.publicState(true).lastAward.points, remainingPoints);
  assert.equal(await room.applyAction({ type: "undo-award" }), true);
  assert.equal(room.publicState(true).teams[0].score, 0);
  assert.equal(room.publicState(true).roundBank, remainingPoints);
  assert.equal(room.state.allocations.length, 1);
  assert.deepEqual(room.state.allocations[0].owner, { type: "bank" });
});

test("removing and restoring a team preserves its allocation history", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "team-count", count: 3 }), true);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 2 }), true);
  assert.equal(await room.applyAction({ type: "team-count", count: 2 }), true);
  assert.equal(room.publicState(true).roundBank, 0);
  assert.deepEqual(room.state.allocations[0].owner, { type: "team", teamIndex: 2 });
  assert.equal(room.publicState(true).lastAward, null);
  assert.equal(await room.applyAction({ type: "team-count", count: 3 }), true);
  assert.equal(room.publicState(true).teams[2].score, 50);
});

test("reset clears allocations and saved state for every question", async () => {
  const room = new GameRoom(context(), env);
  await room.ready;
  room.state = room.initialState("ABCD", TEST_QUESTIONS);
  assert.equal(await room.applyAction({ type: "reveal", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "award", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "strike" }), true);
  assert.equal(await room.applyAction({ type: "question", index: 1 }), true);
  assert.equal(await room.applyAction({ type: "multiplier", value: 3 }), true);
  assert.equal(await room.applyAction({ type: "reveal-only", index: 0 }), true);
  assert.equal(await room.applyAction({ type: "question-visibility", visible: true }), true);

  assert.equal(await room.applyAction({ type: "reset" }), true);
  assert.deepEqual(room.state.allocations, []);
  assert.equal(room.publicState(true).teams[0].score, 0);
  assert.equal(room.publicState(true).multiplier, 1);
  assert.equal(room.publicState(true).questionVisible, false);
  assert.equal(room.publicState(true).question.answers[0].revealed, false);
  assert.equal(await room.applyAction({ type: "question", index: 0 }), true);
  assert.equal(room.publicState(true).teams[0].strikes, 0);
  assert.equal(room.publicState(true).lastAward, null);
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
