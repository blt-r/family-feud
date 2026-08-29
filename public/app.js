const app = document.querySelector("#app");
const statusRegion = document.querySelector("#status-region");
const page = document.body.dataset.page;
const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
let roomCode = (params.get("room") || "").toUpperCase();
let hostToken = page === "host" ? hashParams.get("token") || params.get("token") || (roomCode ? localStorage.getItem(`feud-host-${roomCode}`) : "") || "" : "";
let socket = null;
let game = null;
let online = false;
let reconnectTimer = null;
let connectionAttempt = 0;
let connectionMessage = "";
let lastEventSequence = 0;
let hasReceivedState = false;
let pendingRevealIndexes = new Set();
let soundEnabled = false;
let roomEnded = false;

if (page === "host" && (params.has("token") || hashParams.has("token"))) {
  const cleanURL = new URL(location.href);
  cleanURL.searchParams.delete("token");
  cleanURL.hash = "";
  history.replaceState({}, "", `${cleanURL.pathname}${cleanURL.search}`);
}

const sounds = page === "display" ? {
  correct: new Audio("/sfx/correct.mp3"),
  wrong: new Audio("/sfx/wrong.mp3"),
  intro: new Audio("/sfx/intro.mp3"),
  "round-win": new Audio("/sfx/round-win.mp3")
} : {};

Object.values(sounds).forEach((sound) => { sound.preload = "auto"; });

const escapeHTML = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[character]);

const formatAnswerText = (value = "") => escapeHTML(value).replaceAll("/", '<span class="answer-separator">/</span>');

function wsURL(role) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/rooms/${roomCode}/socket?role=${role}`;
}

async function claimHostAccess() {
  if (!hostToken) return;
  const response = await fetch(`/api/rooms/${roomCode}/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${hostToken}` }
  });
  if (!response.ok) throw Object.assign(new Error("This private host link is invalid or has expired."), { terminal: true });
  localStorage.removeItem(`feud-host-${roomCode}`);
  hostToken = "";
}

function applyState(nextState, allowEvent = true) {
  if (page === "display" && game?.questionIndex === nextState.questionIndex) {
    pendingRevealIndexes = new Set(nextState.question.answers.flatMap((answer, index) => answer.revealed && !game.question.answers[index]?.revealed ? [index] : []));
  } else {
    pendingRevealIndexes = new Set();
  }
  const sequence = Number(nextState.eventSequence) || 0;
  const isNewEvent = allowEvent && hasReceivedState && sequence > lastEventSequence;
  game = nextState;
  hasReceivedState = true;
  lastEventSequence = Math.max(lastEventSequence, sequence);
  render();
  if (isNewEvent && game.lastEvent) playEvent(game.lastEvent);
}

function failConnection(message) {
  roomEnded = true;
  connectionAttempt += 1;
  online = false;
  game = null;
  hostToken = "";
  clearTimeout(reconnectTimer);
  if (page === "host" && roomCode) localStorage.removeItem(`feud-host-${roomCode}`);
  history.replaceState({}, "", page === "host" ? "/host" : "/");
  roomCode = "";
  if (page === "host") hostLobby(message);
  else displayLobby(message);
}

async function connect(role) {
  clearTimeout(reconnectTimer);
  const attempt = ++connectionAttempt;
  connectionMessage = "";

  try {
    if (role === "host") await claimHostAccess();
    const stateResponse = await fetch(`/api/rooms/${roomCode}/state?role=${role}`, { cache: "no-store" });
    if (attempt !== connectionAttempt) return;
    if (stateResponse.status === 404) return failConnection("That room does not exist or has expired.");
    if (stateResponse.status === 403) return failConnection("This private host link is invalid or has expired.");
    if (!stateResponse.ok) throw new Error(`Room check returned ${stateResponse.status}`);
    applyState(await stateResponse.json(), false);
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    if (error.terminal) return failConnection(error.message);
    online = false;
    connectionMessage = "Can’t reach the room. Retrying…";
    render();
    reconnectTimer = setTimeout(() => connect(role), 1600);
    return;
  }

  const activeSocket = new WebSocket(wsURL(role));
  socket = activeSocket;

  activeSocket.addEventListener("open", () => {
    if (socket !== activeSocket) return;
    online = true;
    connectionMessage = "";
    render();
  });

  activeSocket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "state") applyState(message.state);
    if (message.type === "room-ended") handleRoomEnded(message.reason);
    if (message.type === "action-error") showToast(message.error || "The host action was rejected");
  });

  activeSocket.addEventListener("close", () => {
    if (socket !== activeSocket) return;
    online = false;
    render();
    if (!roomEnded) reconnectTimer = setTimeout(() => connect(role), 1600);
  });
}

function send(type, data = {}) {
  if (socket?.readyState !== WebSocket.OPEN) {
    showToast("Control is offline. Reconnecting…");
    return false;
  }
  socket.send(JSON.stringify({ type, ...data }));
  return true;
}

function handleRoomEnded(reason) {
  roomEnded = true;
  connectionAttempt += 1;
  online = false;
  game = null;
  socket = null;
  clearTimeout(reconnectTimer);
  if (page === "host" && roomCode) localStorage.removeItem(`feud-host-${roomCode}`);
  roomCode = "";
  hostToken = "";
  history.replaceState({}, "", page === "host" ? "/host" : "/");
  if (page === "host") hostLobby(reason === "inactive" ? "The room expired after 24 hours without host activity." : "The room has ended and its data was deleted.");
  else displayLobby(reason === "inactive" ? "This room expired after 24 hours without host activity." : "The host ended this room.");
}

async function enableSounds() {
  try {
    await Promise.all(Object.values(sounds).map(async (sound) => {
      const volume = sound.volume;
      sound.volume = 0;
      await sound.play();
      sound.pause();
      sound.currentTime = 0;
      sound.volume = volume;
    }));
    soundEnabled = true;
    render();
  } catch {
    showToast("Tap again to enable sound");
  }
}

function playSound(name) {
  const sound = sounds[name];
  if (!sound || !soundEnabled) return;
  sound.currentTime = 0;
  sound.play().catch(() => {
    soundEnabled = false;
    render();
  });
}

function stopSounds() {
  Object.values(sounds).forEach((sound) => {
    sound.pause();
    sound.currentTime = 0;
  });
}

function playEvent(event) {
  if (page === "display" && event.type === "strike") {
    const strikeCount = Math.max(1, Math.min(3, Number(event.strikes) || Number(game?.teams?.[event.team]?.strikes) || 1));
    const overlay = document.createElement("div");
    overlay.className = "strike-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `<div class="strike-x-group" data-count="${strikeCount}" style="--strike-count:${strikeCount}">${'<div class="giant-x">X</div>'.repeat(strikeCount)}</div>`;
    document.body.append(overlay);
    setTimeout(() => overlay.remove(), 1000);
    playSound("wrong");
  }
  if (page === "display" && event.type === "reveal") {
    playSound("correct");
  }
  if (page === "display" && event.type === "sound") {
    if (event.name === "stop") stopSounds();
    else playSound(event.name);
  }
  if (page === "host" && event.type === "award") showToast(`Awarded ${event.points} points`);
}

function showToast(text) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  document.body.append(toast);
  if (statusRegion) statusRegion.textContent = text;
  setTimeout(() => toast.remove(), 2500);
}

function fitQuestionText() {
  const banner = document.querySelector(".question-banner");
  if (!banner?.textContent.trim()) return;
  banner.style.fontSize = "";
  let size = Number.parseFloat(getComputedStyle(banner).fontSize);
  while (banner.scrollHeight > banner.clientHeight && size > 7) {
    size -= 0.5;
    banner.style.fontSize = `${size}px`;
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through for browsers that block Clipboard API access.
    }
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.inset = "0 auto auto -9999px";
  document.body.append(helper);
  helper.select();
  helper.setSelectionRange(0, helper.value.length);
  const copied = document.execCommand("copy");
  helper.remove();
  return copied;
}

function displayLobby(error = "") {
  app.innerHTML = `
    <section class="lobby">
      <div class="lobby-card">
        <div class="lobby-mark">F</div>
        <p class="eyebrow">Audience display</p>
        <h1>Ready for the face-off?</h1>
        <p class="muted">Enter the room code shown on the host's phone to put this screen in the game.</p>
        <form class="join-form" id="join-display">
          <input class="code-input" name="code" minlength="5" maxlength="6" placeholder="ABCDEF" aria-label="Five or six character room code" autocomplete="off" required />
          <button class="primary-button">Open game board</button>
          <a class="host-game-link" href="/host">Host a game</a>
          ${error ? `<div class="form-error" role="alert">${escapeHTML(error)}</div>` : ""}
        </form>
      </div>
    </section>`;

  document.querySelector("#join-display").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code").toString().trim().toUpperCase();
    if (!/^[A-Z0-9]{5,6}$/.test(code)) return displayLobby("Use the five- or six-character room code.");
    location.href = `/?room=${encodeURIComponent(code)}`;
  });
}

function renderDisplay() {
  if (!roomCode) return displayLobby();
  if (!game) {
    app.innerHTML = `
      <section class="lobby"><div class="lobby-card">
        <div class="lobby-mark">F</div><p class="eyebrow">Room ${escapeHTML(roomCode)}</p>
        <h1>Warming up the board</h1><p class="muted">${escapeHTML(connectionMessage || "Connecting to the host…")}</p>
      </div></section>`;
    return;
  }

  const answers = Array.from({ length: 8 }, (_, index) => {
    const answer = game.question.answers[index];
    if (!answer) return '<div class="answer-tile answer-placeholder" aria-hidden="true"></div>';
    return `
      <div class="answer-tile ${answer.revealed && !pendingRevealIndexes.has(index) ? "is-revealed" : ""}" ${pendingRevealIndexes.has(index) ? 'data-animate-reveal="true"' : ""}>
        <div class="answer-face answer-hidden"><span class="answer-number">${index + 1}</span><span></span><span></span></div>
        <div class="answer-face answer-revealed">
          <span></span><span class="answer-text">${formatAnswerText(answer.text || "")}</span><span class="answer-points">${answer.points ?? ""}</span>
        </div>
      </div>`;
  }).join("");

  const teams = game.teams.map((team, index) => `
    <div class="team-score ${game.activeTeam === index ? "active" : ""}" style="--team-color:${team.color}">
      <div><div class="team-name">${escapeHTML(team.name)}</div><div class="team-status" aria-label="${team.strikes} strikes">${"X".repeat(team.strikes)}</div></div>
      <div class="score-number">${team.score}</div>
    </div>`).join("");

  app.innerHTML = `
    <div class="game-stage">
      <section class="stage-content">
        <div class="question-slot">
          <div class="question-banner" aria-hidden="${!game.questionVisible}">${game.questionVisible ? escapeHTML(game.question.prompt) : ""}</div>
        </div>
        <div class="bank-board">
          <strong>${game.roundBank}</strong>
        </div>
        <div class="answer-board" style="--answer-rows:4">${answers}</div>
      </section>
      <footer class="teams-strip" style="--team-count:${game.teams.length}">${teams}</footer>
    </div>
    ${soundEnabled ? "" : '<button class="sound-gate" id="enable-sound"><span>♪</span> Tap to enable game sound</button>'}`;

  requestAnimationFrame(() => {
    document.querySelectorAll("[data-animate-reveal]").forEach((tile) => tile.classList.add("is-revealed"));
    pendingRevealIndexes.clear();
    fitQuestionText();
  });
  document.fonts?.ready.then(fitQuestionText);
  document.querySelector("#enable-sound")?.addEventListener("click", enableSounds);
}

function hostLobby(error = "") {
  app.innerHTML = `
    <section class="lobby">
      <div class="lobby-card">
        <div class="lobby-mark">H</div>
        <p class="eyebrow">Host controls</p>
        <h1>Run the room</h1>
        <p class="muted">Create a private game, open the board on a TV or projector, then control every reveal from this phone.</p>
        <div class="join-form">
          <label class="toggle-row">
            <span><strong>Family-friendly questions</strong><small>Filter explicit prompts and answers</small></span>
            <input type="checkbox" id="create-family-mode" checked />
          </label>
          <button class="primary-button" id="create-game">Create a new game</button>
          ${error ? `<div class="form-error" role="alert">${escapeHTML(error)}</div>` : ""}
        </div>
      </div>
    </section>`;

  document.querySelector("#create-game").addEventListener("click", async (event) => {
    const familyFriendly = document.querySelector("#create-family-mode").checked;
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = "Creating game…";
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ familyFriendly })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Could not create the game.");
      }
      const result = await response.json();
      location.href = `/host?room=${encodeURIComponent(result.code)}#token=${encodeURIComponent(result.hostToken)}`;
    } catch (error) {
      hostLobby(error.message);
    }
  });
}

function roundInProgress() {
  return game && (game.roundBank > 0 || game.question.answers.some((answer) => answer.revealed) || game.teams.some((team) => team.strikes > 0));
}

function confirmRoundChange(action) {
  return !roundInProgress() || confirm(`${action} will clear the current bank, revealed answers, and strikes. Continue?`);
}

async function privateHostURL() {
  const response = await fetch(`/api/rooms/${roomCode}/host-link`, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not create a private host link");
  const result = await response.json();
  return `${location.origin}/host?room=${encodeURIComponent(roomCode)}#token=${encodeURIComponent(result.hostToken)}`;
}

function renderHost() {
  if (!roomCode) return hostLobby();
  if (!game) {
    app.innerHTML = `<section class="lobby"><div class="lobby-card"><div class="lobby-mark">H</div><p class="eyebrow">Room ${escapeHTML(roomCode)}</p><h1>Opening controls</h1><p class="muted">${escapeHTML(connectionMessage || "Connecting securely…")}</p></div></section>`;
    return;
  }

  const answerButtons = game.question.answers.map((answer, index) => `
    <button class="answer-control ${answer.revealed ? "revealed" : ""}" data-reveal="${index}" aria-label="Reveal answer ${index + 1}: ${escapeHTML(answer.text)}, ${answer.points} points" ${answer.revealed ? "disabled" : ""}>
      <span class="number">${index + 1}</span><span class="text">${formatAnswerText(answer.text)}</span><span class="points">${answer.points}</span>
    </button>`).join("");

  const teamButtons = game.teams.map((team, index) => `
    <button class="team-button ${game.activeTeam === index ? "active" : ""}" data-team="${index}" aria-pressed="${game.activeTeam === index}" style="--team-color:${team.color}">
      <span class="team-button-name">${escapeHTML(team.name)}</span>
      <span class="team-button-meta">${team.score} PTS · ${team.strikes} X</span>
    </button>`).join("");

  const nameFields = game.teams.map((team, index) => `
    <label class="team-name-row" style="--team-color:${team.color}"><span class="color-dot"></span><input class="field" data-team-name="${index}" value="${escapeHTML(team.name)}" maxlength="24" aria-label="Team ${index + 1} name" /></label>`).join("");

  const questionOptions = game.questionTitles.map((title, index) => `<option value="${index}" ${index === game.questionIndex ? "selected" : ""}>${index + 1}. ${escapeHTML(title)}</option>`).join("");
  const displayURL = `${location.origin}/?room=${encodeURIComponent(game.code)}`;

  app.innerHTML = `
    <div class="host-shell ${online ? "" : "is-offline"}">
      <header class="host-header">
        <div class="host-brand">Family <span>Feud</span></div>
        <div class="host-room"><span class="connection-dot ${online ? "" : "offline"}"></span> ROOM ${escapeHTML(game.code)}</div>
      </header>
      <main class="host-main">
        <section class="host-section round-setup requires-connection">
          <div class="section-heading"><h2>Round setup</h2></div>
          <div class="settings-grid">
            <div><span class="control-label" id="multiplier-label">Point multiplier</span><div class="segmented" role="group" aria-labelledby="multiplier-label">${[1, 2, 3].map((value) => `<button class="segment ${game.multiplier === value ? "active" : ""}" data-multiplier="${value}" aria-pressed="${game.multiplier === value}">${value}×</button>`).join("")}</div></div>
            <div><span class="control-label" id="team-count-label">Number of teams</span><div class="segmented" role="group" aria-labelledby="team-count-label">${[2, 3, 4].map((value) => `<button class="segment ${game.teams.length === value ? "active" : ""}" data-count="${value}" aria-pressed="${game.teams.length === value}">${value}</button>`).join("")}</div></div>
            <div><span class="control-label">Team names</span><div class="settings-grid">${nameFields}</div></div>
          </div>
        </section>

        <section class="host-section show-sounds requires-connection">
          <div class="section-heading"><h2>Show sounds</h2></div>
          <div class="mini-actions"><button class="secondary-button" data-sound="intro">Play intro</button><button class="secondary-button" data-sound="round-win">Play round win</button><button class="secondary-button" data-sound="stop">Stop sounds</button></div>
        </section>

        <section class="host-section gameplay requires-connection">
          <div class="section-heading"><h2>Who's playing?</h2><span class="bank-value">BANK ${game.roundBank}</span></div>
          <div class="team-picker">${teamButtons}</div>
          <div class="bank-action">
            <button class="award-button" id="award-bank" ${game.roundBank === 0 ? "disabled" : ""}>Award bank<strong>${game.roundBank} pts</strong></button>
          </div>
        </section>

        <section class="host-section question-selection requires-connection">
          <div class="section-heading"><h2>Question</h2></div>
          <label class="control-label" for="question-select">Current question</label>
          <select class="field" id="question-select">${questionOptions}</select>
          <p class="question-preview">${escapeHTML(game.question.prompt)}</p>
          <button class="question-visibility-button ${game.questionVisible ? "is-visible" : ""}" id="question-visibility" aria-pressed="${game.questionVisible}">${game.questionVisible ? "Hide question from display" : "Reveal question on display"}</button>
        </section>

        <section class="host-section answers requires-connection">
          <div class="section-heading"><h2>Answers</h2><span class="muted">Tap to reveal</span></div>
          <div class="answer-controls">${answerButtons}</div>
          <div class="answer-verdict-actions">
            <button class="strike-button" id="add-strike">Add X</button>
            <button class="secondary-button" id="undo-strike">Undo X</button>
          </div>
        </section>

        <section class="host-section question-library requires-connection">
          <div class="section-heading"><h2>Question library</h2><span class="muted">${game.questionCount} loaded</span></div>
          <div class="settings-grid">
            <label class="toggle-row">
              <span><strong>Family-friendly questions</strong><small>Changing this loads a new filtered set and clears the current round</small></span>
              <input type="checkbox" id="family-mode" ${game.familyFriendly ? "checked" : ""} />
            </label>
            <button class="secondary-button refresh-questions-button" id="refresh-questions">Load 25 new questions</button>
            <p class="host-note muted">Team names and total scores stay in place. Revealed answers, strikes, and the round bank are cleared.</p>
          </div>
        </section>

        <section class="host-section">
          <div class="section-heading"><h2>Game board</h2></div>
          <p class="host-note muted">Open this on the TV or projector. Anyone with the link sees the board, but only this private host link can control it.</p>
          <div class="manual-code">
            <span class="control-label">Manual room code</span>
            <strong>${escapeHTML(game.code)}</strong>
          </div>
          <a class="display-link" href="${displayURL}" target="_blank" rel="noreferrer">Open audience display ↗</a>
          <div class="mini-actions link-actions"><button class="secondary-button" id="copy-display">Copy board link</button><button class="secondary-button" id="copy-host">Copy host link</button></div>
        </section>

        <section class="host-section requires-connection">
          <div class="section-heading"><h2>Room controls</h2></div>
          <p class="host-note muted">Clear all scores, strikes, and revealed answers. Team names stay in place.</p>
          <button class="danger-button room-control-button" id="reset-game">Reset entire game</button>
          <div class="end-room-control">
            <p class="host-note muted">Permanently close this room and disconnect the audience display. This cannot be undone.</p>
            <button class="danger-button room-control-button end-room-button" id="end-room">End room permanently</button>
          </div>
        </section>
      </main>
    </div>`;

  if (!online) {
    document.querySelectorAll(".requires-connection button, .requires-connection input, .requires-connection select").forEach((control) => { control.disabled = true; });
  }

  document.querySelectorAll("[data-reveal]").forEach((button) => button.addEventListener("click", () => send("reveal", { index: Number(button.dataset.reveal) })));
  document.querySelectorAll("[data-team]").forEach((button) => button.addEventListener("click", () => send("active-team", { index: Number(button.dataset.team) })));
  document.querySelectorAll("[data-multiplier]").forEach((button) => button.addEventListener("click", () => send("multiplier", { value: Number(button.dataset.multiplier) })));
  document.querySelectorAll("[data-count]").forEach((button) => button.addEventListener("click", () => send("team-count", { count: Number(button.dataset.count) })));
  document.querySelectorAll("[data-sound]").forEach((button) => button.addEventListener("click", () => send("sound", { name: button.dataset.sound })));
  document.querySelectorAll("[data-team-name]").forEach((input) => input.addEventListener("change", () => send("rename-team", { index: Number(input.dataset.teamName), name: input.value })));
  document.querySelector("#family-mode").addEventListener("change", (event) => {
    if (!confirmRoundChange("Changing the question filter")) {
      event.target.checked = game.familyFriendly;
      return;
    }
    send("family-mode", { enabled: event.target.checked });
  });
  document.querySelector("#refresh-questions").addEventListener("click", () => {
    if (confirm("Load 25 new questions and clear the current round?")) send("refresh-questions");
  });
  document.querySelector("#add-strike").addEventListener("click", () => send("strike"));
  document.querySelector("#undo-strike").addEventListener("click", () => send("undo-strike"));
  document.querySelector("#award-bank").addEventListener("click", () => send("award"));
  document.querySelector("#question-visibility").addEventListener("click", () => send("question-visibility", { visible: !game.questionVisible }));
  document.querySelector("#question-select").addEventListener("change", (event) => {
    const index = Number(event.target.value);
    if (!confirmRoundChange("Changing questions")) {
      event.target.value = String(game.questionIndex);
      return;
    }
    send("question", { index });
  });
  document.querySelector("#copy-display").addEventListener("click", async () => {
    const copied = await copyText(displayURL);
    showToast(copied ? "Display link copied" : "Could not copy link");
  });
  document.querySelector("#copy-host").addEventListener("click", async () => {
    try {
      const hostURL = await privateHostURL();
      const copied = await copyText(hostURL);
      showToast(copied ? "Private host link copied" : "Could not copy link");
    } catch (error) {
      showToast(error.message || "Could not copy host link");
    }
  });
  document.querySelector("#reset-game").addEventListener("click", () => { if (confirm("Reset all scores and this round?")) send("reset"); });
  document.querySelector("#end-room").addEventListener("click", () => { if (confirm("Permanently end this room and delete all of its data?")) send("end-room"); });
}

function render() {
  if (page === "host") renderHost();
  else renderDisplay();
}

render();
if (roomCode) connect(page === "host" ? "host" : "display");
