const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CREATION_WINDOW_MS = 10 * 60 * 1000;
const CREATION_LIMIT = 20;
const QUESTIONS_PER_ANSWER_COUNT = 5;
const ROOM_CODE_LENGTH = 4;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;
const STATE_SCHEMA_VERSION = 3;
const TEAM_COLORS = ["#36a4ff", "#ffbf3f", "#ff5c76", "#5de0a2"];
const DEFAULT_TEAM_NAMES = ["Team 1", "Team 2", "Team 3", "Team 4"];
let questionBankPromise;

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function makeToken() {
  return crypto.randomUUID().replaceAll("-", "");
}

function shuffle(items) {
  const result = [...items];
  const random = new Uint32Array(1);
  for (let index = result.length - 1; index > 0; index -= 1) {
    crypto.getRandomValues(random);
    const swapIndex = random[0] % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function normalizeQuestionKey(prompt) {
  return String(prompt || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isValidQuestion(question) {
  if (!question || typeof question.prompt !== "string" || !Array.isArray(question.answers)) return false;
  if (question.answers.length < 3 || question.answers.length > 8) return false;
  const answerKeys = new Set();
  for (const answer of question.answers) {
    const key = String(answer?.text || "").trim().toLowerCase();
    if (!key || answerKeys.has(key) || !Number.isInteger(answer.points) || answer.points < 0 || answer.points > 100) return false;
    answerKeys.add(key);
  }
  return true;
}

function cleanQuestionBank(questionBank) {
  const unique = new Map();
  for (const question of Array.isArray(questionBank) ? questionBank : []) {
    if (!isValidQuestion(question)) continue;
    const key = normalizeQuestionKey(question.prompt);
    if (key && !unique.has(key)) unique.set(key, question);
  }
  return [...unique.values()];
}

async function loadQuestionBank(env, requestURL) {
  if (!questionBankPromise) {
    questionBankPromise = env.ASSETS.fetch(new Request(new URL("/data/questions.json", requestURL)))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Question bank returned ${response.status}`);
        const questions = cleanQuestionBank(await response.json());
        if (!questions.length) throw new Error("Question bank contains no valid questions");
        return questions;
      });
  }

  try {
    return await questionBankPromise;
  } catch (error) {
    questionBankPromise = undefined;
    throw error;
  }
}

export function pickQuestionSet(questionBank, familyFriendly = true) {
  const cleaned = cleanQuestionBank(questionBank);
  const eligible = familyFriendly
    ? cleaned.filter((question) => question.familyFriendly !== false)
    : cleaned;
  const selected = [];
  for (let answerCount = 3; answerCount <= 7; answerCount += 1) {
    const matching = eligible.filter((question) => question.answers.length === answerCount);
    selected.push(...shuffle(matching).slice(0, QUESTIONS_PER_ANSWER_COUNT));
  }
  return shuffle(selected.length ? selected : eligible).slice(0, 25);
}

function roomCookieName(code) {
  return `feud_host_${code}`;
}

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function bearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function hostCookie(request, code, token) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${roomCookieName(code)}=${encodeURIComponent(token)}; Max-Age=86400; HttpOnly; SameSite=Strict; Path=/api/rooms/${code}${secure}`;
}

async function checkCreationLimit(request, env) {
  if (!env.ROOM_CREATION_LIMITER) return null;
  const address = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "local-development";
  const id = env.ROOM_CREATION_LIMITER.idFromName(address);
  const response = await env.ROOM_CREATION_LIMITER.get(id).fetch("https://limiter.internal/check", { method: "POST" });
  return response.ok ? null : response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const limited = await checkCreationLimit(request, env);
      if (limited) return limited;
      const settings = await request.json().catch(() => ({}));
      const familyFriendly = settings.familyFriendly !== false;
      let questionBank;
      try {
        questionBank = await loadQuestionBank(env, request.url);
      } catch (error) {
        console.error("Could not load question bank", error);
        return Response.json({ error: "The question library is unavailable. Please try again." }, { status: 503, headers: JSON_HEADERS });
      }
      const questions = pickQuestionSet(questionBank, familyFriendly);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = makeCode();
        const token = makeToken();
        const id = env.GAME_ROOMS.idFromName(code);
        const response = await env.GAME_ROOMS.get(id).fetch("https://room.internal/init", {
          method: "POST",
          body: JSON.stringify({ code, token, questions, familyFriendly })
        });
        if (response.status === 201) return Response.json({ code, hostToken: token }, { headers: JSON_HEADERS });
        if (response.status !== 409) return Response.json({ error: "Could not create room" }, { status: 503, headers: JSON_HEADERS });
      }
      return Response.json({ error: "Could not allocate a unique room code" }, { status: 503, headers: JSON_HEADERS });
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4})\/(socket|state|claim|host-link)$/);
    if (match && ROOM_CODE_PATTERN.test(match[1])) {
      const id = env.GAME_ROOMS.idFromName(match[1]);
      return env.GAME_ROOMS.get(id).fetch(request);
    }
    if (["GET", "HEAD"].includes(request.method) && ["/host", "/host/"].includes(url.pathname)) {
      url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.hostToken = null;
    this.ready = this.ctx.blockConcurrencyWhile(() => this.load());
  }

  async load() {
    const saved = await this.ctx.storage.get(["state", "hostToken"]);
    this.state = saved.get("state") || null;
    this.hostToken = saved.get("hostToken") || null;
    if (this.state) {
      if (this.state.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(this.state.allocations)) {
        this.state = this.initialState(this.state.code, this.state.questions, this.state.familyFriendly !== false);
        await this.ctx.storage.put("state", this.state);
        return;
      }
      this.state.eventSequence = Number.isSafeInteger(this.state.eventSequence) ? this.state.eventSequence : 0;
      const savedNames = Array.isArray(this.state.teamNames) ? this.state.teamNames : [];
      this.state.teamNames = DEFAULT_TEAM_NAMES.map((fallback, index) => {
        const name = this.state.teams[index]?.name || savedNames[index];
        return typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : fallback;
      });
    }
  }

  initialState(code, questions, familyFriendly = true) {
    const rounds = {};
    const questionRoundIds = questions.map((_question, index) => {
      const roundId = index + 1;
      rounds[roundId] = this.initialRoundState();
      return roundId;
    });
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      code,
      questions,
      questionRoundIds,
      archivedQuestionSets: [],
      rounds,
      questionIndex: 0,
      intermissionVisible: true,
      allocations: [],
      nextRoundId: questions.length + 1,
      nextAwardId: 1,
      familyFriendly,
      teamNames: [...DEFAULT_TEAM_NAMES],
      teams: [
        { name: DEFAULT_TEAM_NAMES[0], color: TEAM_COLORS[0] },
        { name: DEFAULT_TEAM_NAMES[1], color: TEAM_COLORS[1] }
      ],
      eventSequence: 0,
      lastEvent: null
    };
  }

  initialRoundState() {
    return { multiplier: 1, questionVisible: false, activeTeam: 0, strikes: [0, 0, 0, 0], lastAwardId: null };
  }

  isHostRequest(request) {
    return cookieValue(request, roomCookieName(this.state.code)) === this.hostToken;
  }

  publicState(forHost = false) {
    const question = this.state.questions[this.state.questionIndex];
    const round = this.currentRound();
    const currentAllocations = this.currentAllocations();
    const allocationsByAnswer = new Map(currentAllocations.map((allocation) => [allocation.answerIndex, allocation]));
    return {
      code: this.state.code,
      questionIndex: this.state.questionIndex,
      questionCount: this.state.questions.length,
      questionVisible: round.questionVisible,
      intermissionVisible: this.state.intermissionVisible === true,
      question: {
        prompt: forHost || round.questionVisible ? question.prompt : null,
        answers: question.answers.map((answer, index) => {
          const allocation = allocationsByAnswer.get(index);
          return {
            text: allocation || forHost ? answer.text : null,
            points: allocation || forHost ? answer.points : null,
            revealed: Boolean(allocation),
            owner: forHost ? allocation?.owner || null : undefined
          };
        })
      },
      questionTitles: forHost ? this.state.questions.map((item) => item.prompt) : undefined,
      activeTeam: round.activeTeam,
      roundBank: this.allocationTotal(currentAllocations.filter((allocation) => allocation.owner.type === "bank")),
      multiplier: round.multiplier,
      familyFriendly: this.state.familyFriendly !== false,
      teams: this.state.teams.map((team, index) => ({ ...team, score: this.teamScore(index), strikes: round.strikes[index] || 0 })),
      lastAward: forHost ? this.lastAward() : undefined,
      eventSequence: this.state.eventSequence,
      lastEvent: this.state.lastEvent
    };
  }

  currentRoundId() {
    return this.state.questionRoundIds[this.state.questionIndex];
  }

  currentRound() {
    return this.state.rounds[this.currentRoundId()];
  }

  currentAllocations() {
    const roundId = this.currentRoundId();
    return this.state.allocations.filter((allocation) => allocation.roundId === roundId);
  }

  allocationTotal(allocations) {
    return allocations.reduce((total, allocation) => total + allocation.basePoints * allocation.multiplier, 0);
  }

  teamScore(team) {
    return this.allocationTotal(this.state.allocations.filter((allocation) => allocation.owner.type === "team" && allocation.owner.teamIndex === team));
  }

  lastAward() {
    const awardId = this.currentRound().lastAwardId;
    if (!Number.isInteger(awardId)) return null;
    const allocations = this.state.allocations.filter((allocation) => allocation.awardId === awardId);
    const owner = allocations[0]?.owner;
    if (owner?.type !== "team" || !Number.isInteger(owner.teamIndex)) return null;
    return { team: owner.teamIndex, points: this.allocationTotal(allocations) };
  }

  recordEvent(type, details = {}) {
    this.state.eventSequence += 1;
    this.state.lastEvent = { type, ...details, sequence: this.state.eventSequence, at: Date.now() };
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.state) return new Response(null, { status: 409 });
      const { code, token, questions, familyFriendly } = await request.json();
      if (!ROOM_CODE_PATTERN.test(code) || typeof token !== "string" || token.length < 24 || !Array.isArray(questions) || !questions.length) {
        return Response.json({ error: "Invalid room initialization" }, { status: 400, headers: JSON_HEADERS });
      }
      this.hostToken = token;
      this.state = this.initialState(code, questions, familyFriendly);
      await this.ctx.storage.put({ state: this.state, hostToken: token });
      await this.refreshExpiration();
      return new Response(null, { status: 201 });
    }

    if (!this.state) return Response.json({ error: "Game not found" }, { status: 404, headers: JSON_HEADERS });

    if (url.pathname.endsWith("/claim") && request.method === "POST") {
      if (bearerToken(request) !== this.hostToken) return Response.json({ error: "Invalid host link" }, { status: 403, headers: JSON_HEADERS });
      return new Response(null, { status: 204, headers: { "Set-Cookie": hostCookie(request, this.state.code, this.hostToken) } });
    }
    if (url.pathname.endsWith("/host-link")) {
      if (!this.isHostRequest(request)) return Response.json({ error: "Host authentication required" }, { status: 403, headers: JSON_HEADERS });
      return Response.json({ hostToken: this.hostToken }, { headers: JSON_HEADERS });
    }
    if (url.pathname.endsWith("/state")) {
      const wantsHostState = url.searchParams.get("role") === "host";
      if (wantsHostState && !this.isHostRequest(request)) return Response.json({ error: "Host authentication required" }, { status: 403, headers: JSON_HEADERS });
      return Response.json(this.publicState(wantsHostState), { headers: JSON_HEADERS });
    }
    if (url.pathname.endsWith("/socket")) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const role = url.searchParams.get("role") === "host" ? "host" : "display";
      if (role === "host" && !this.isHostRequest(request)) return new Response("Invalid host link", { status: 403 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role });
      server.send(JSON.stringify({ type: "state", state: this.publicState(role === "host") }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket, message) {
    await this.ready;
    const attachment = socket.deserializeAttachment?.();
    const isHost = attachment?.role === "host" || this.ctx.getTags(socket).includes("host");
    if (!isHost || !this.state) return;
    let action;
    try {
      action = JSON.parse(message);
    } catch {
      socket.send(JSON.stringify({ type: "action-error", error: "Invalid action" }));
      return;
    }
    try {
      const result = await this.applyAction(action);
      if (result === "ended") return;
      if (!result) {
        socket.send(JSON.stringify({ type: "action-error", error: "Action was rejected" }));
        return;
      }
      await this.ctx.storage.put("state", this.state);
      await this.refreshExpiration();
      this.broadcast();
    } catch (error) {
      console.error("Host action failed", error);
      socket.send(JSON.stringify({ type: "action-error", error: "Action failed" }));
    }
  }

  async applyAction(action) {
    if (!action || typeof action !== "object" || typeof action.type !== "string") return false;
    const current = this.state.questions[this.state.questionIndex];
    const round = this.currentRound();
    const integer = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
    switch (action.type) {
      case "reveal":
      case "reveal-only": {
        const index = integer(action.index, 0, current.answers.length - 1);
        if (index === null || this.currentAllocations().some((allocation) => allocation.answerIndex === index)) return false;
        const answer = current.answers[index];
        this.state.allocations.push({
          roundId: this.currentRoundId(),
          questionId: current.id || normalizeQuestionKey(current.prompt),
          question: current.prompt,
          answerIndex: index,
          answer: answer.text,
          basePoints: answer.points,
          multiplier: round.multiplier,
          owner: { type: action.type === "reveal" ? "bank" : "unscored" },
          awardId: null
        });
        this.recordEvent("reveal", { index, scored: action.type === "reveal" });
        return true;
      }
      case "hide-answer": {
        const index = integer(action.index, 0, current.answers.length - 1);
        const allocation = index === null ? null : this.currentAllocations().find((entry) => entry.answerIndex === index);
        if (!allocation) return false;
        this.state.allocations = this.state.allocations.filter((entry) => entry !== allocation);
        if (allocation.awardId === round.lastAwardId && !this.state.allocations.some((entry) => entry.awardId === round.lastAwardId)) {
          round.lastAwardId = null;
        }
        this.recordEvent("hide-answer", { index });
        return true;
      }
      case "strike": {
        const team = this.state.teams[round.activeTeam];
        const strikes = round.strikes[round.activeTeam] || 0;
        if (!team || strikes >= 3) return false;
        round.strikes[round.activeTeam] = strikes + 1;
        this.recordEvent("strike", { team: round.activeTeam, strikes: strikes + 1 });
        return true;
      }
      case "undo-strike": {
        const team = this.state.teams[round.activeTeam];
        const strikes = round.strikes[round.activeTeam] || 0;
        if (!team || strikes <= 0) return false;
        round.strikes[round.activeTeam] = strikes - 1;
        return true;
      }
      case "active-team": {
        const index = integer(action.index, 0, this.state.teams.length - 1);
        if (index === null) return false;
        round.activeTeam = index;
        return true;
      }
      case "award": {
        const requested = action.index === undefined ? round.activeTeam : action.index;
        const index = integer(requested, 0, this.state.teams.length - 1);
        const allocations = this.currentAllocations().filter((allocation) => allocation.owner.type === "bank");
        if (index === null || !allocations.length) return false;
        const points = this.allocationTotal(allocations);
        const awardId = this.state.nextAwardId;
        this.state.nextAwardId += 1;
        allocations.forEach((allocation) => {
          allocation.owner = { type: "team", teamIndex: index };
          allocation.awardId = awardId;
        });
        round.lastAwardId = awardId;
        this.recordEvent("award", { team: index, points });
        return true;
      }
      case "undo-award": {
        const award = this.lastAward();
        if (!award) return false;
        this.state.allocations.forEach((allocation) => {
          if (allocation.awardId !== round.lastAwardId) return;
          allocation.owner = { type: "bank" };
          allocation.awardId = null;
        });
        round.lastAwardId = null;
        this.recordEvent("undo-award", { team: award.team, points: award.points });
        return true;
      }
      case "question": {
        const index = integer(action.index, 0, this.state.questions.length - 1);
        if (index === null || index === this.state.questionIndex) return false;
        this.state.questionIndex = index;
        this.recordEvent("question");
        return true;
      }
      case "question-visibility":
        if (typeof action.visible !== "boolean" || action.visible === round.questionVisible) return false;
        round.questionVisible = action.visible;
        return true;
      case "intermission-visibility":
        if (typeof action.visible !== "boolean" || action.visible === this.state.intermissionVisible) return false;
        this.state.intermissionVisible = action.visible;
        return true;
      case "multiplier":
        if (![1, 2, 3].includes(action.value) || action.value === round.multiplier) return false;
        round.multiplier = action.value;
        this.currentAllocations().forEach((allocation) => { allocation.multiplier = action.value; });
        return true;
      case "family-mode":
        if (typeof action.enabled !== "boolean") return false;
        await this.replaceQuestionSet(action.enabled);
        return true;
      case "refresh-questions":
        await this.replaceQuestionSet(this.state.familyFriendly !== false);
        return true;
      case "sound":
        if (!["intro", "round-win", "stop"].includes(action.name)) return false;
        this.recordEvent("sound", { name: action.name });
        return true;
      case "team-count": {
        const count = integer(action.count, 2, 4);
        if (count === null || count === this.state.teams.length) return false;
        while (this.state.teams.length < count) {
          const index = this.state.teams.length;
          this.state.teams.push({ name: this.state.teamNames[index], color: TEAM_COLORS[index] });
        }
        for (const savedRound of Object.values(this.state.rounds)) {
          if (savedRound.activeTeam >= count) savedRound.activeTeam = 0;
          const awardId = savedRound.lastAwardId;
          const awardAllocation = this.state.allocations.find((allocation) => allocation.awardId === awardId);
          if (awardAllocation?.owner.type === "team" && awardAllocation.owner.teamIndex >= count) savedRound.lastAwardId = null;
        }
        this.state.teams = this.state.teams.slice(0, count);
        return true;
      }
      case "rename-team": {
        const index = integer(action.index, 0, this.state.teams.length - 1);
        const name = typeof action.name === "string" ? action.name.trim().slice(0, 24) : "";
        if (index === null || !name || name === this.state.teams[index].name) return false;
        this.state.teams[index].name = name;
        this.state.teamNames[index] = name;
        return true;
      }
      case "reset":
        this.state.allocations = [];
        Object.keys(this.state.rounds).forEach((roundId) => { this.state.rounds[roundId] = this.initialRoundState(); });
        this.recordEvent("reset");
        return true;
      case "end-room":
        await this.expire("ended");
        return "ended";
      default:
        return false;
    }
  }

  async alarm() {
    await this.ready;
    if (this.state) await this.expire("inactive");
  }

  async refreshExpiration() {
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async replaceQuestionSet(familyFriendly) {
    const questionBank = await loadQuestionBank(this.env, "https://assets.local/");
    this.state.archivedQuestionSets.push({ questions: this.state.questions, questionRoundIds: this.state.questionRoundIds });
    this.state.familyFriendly = familyFriendly;
    this.state.questions = pickQuestionSet(questionBank, familyFriendly);
    this.state.questionRoundIds = this.state.questions.map(() => {
      const roundId = this.state.nextRoundId;
      this.state.nextRoundId += 1;
      this.state.rounds[roundId] = this.initialRoundState();
      return roundId;
    });
    this.state.questionIndex = 0;
    this.recordEvent("question");
  }

  async expire(reason) {
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify({ type: "room-ended", reason });
    for (const socket of sockets) {
      try { socket.send(message); } catch { /* Socket is already closed. */ }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = null;
    this.hostToken = null;
    for (const socket of sockets) {
      try { socket.close(1000, "Room ended"); } catch { /* Socket is already closed. */ }
    }
  }

  broadcast() {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment?.();
        const isHost = attachment?.role === "host" || this.ctx.getTags(socket).includes("host");
        socket.send(JSON.stringify({ type: "state", state: this.publicState(isHost) }));
      } catch {
        // Closed sockets are removed by the runtime.
      }
    }
  }
}

export class RoomCreationLimiter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const now = Date.now();
    const attempts = (await this.ctx.storage.get("attempts") || []).filter((time) => now - time < CREATION_WINDOW_MS);
    if (attempts.length >= CREATION_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((CREATION_WINDOW_MS - (now - attempts[0])) / 1000));
      return Response.json({ error: "Too many rooms created. Try again later." }, { status: 429, headers: { ...JSON_HEADERS, "Retry-After": String(retryAfter) } });
    }
    attempts.push(now);
    await this.ctx.storage.put("attempts", attempts);
    await this.ctx.storage.setAlarm(attempts[0] + CREATION_WINDOW_MS);
    return new Response(null, { status: 204 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
