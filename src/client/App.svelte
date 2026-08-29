<script>
  import { onMount } from "svelte";
  import DisplayPage from "./DisplayPage.svelte";
  import HostPage from "./HostPage.svelte";

  const page = location.pathname === "/host" || location.pathname === "/host/" ? "host" : "display";
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const initialRoomCode = (params.get("room") || "").toUpperCase();

  let roomCode = $state(initialRoomCode);
  let hostToken = page === "host" ? hashParams.get("token") || params.get("token") || (initialRoomCode ? localStorage.getItem(`feud-host-${initialRoomCode}`) : "") || "" : "";
  let game = $state.raw(null);
  let online = $state(false);
  let connectionMessage = $state("");
  let lobbyError = $state("");
  let soundEnabled = $state(false);
  let toast = $state.raw(null);
  let strikeEvent = $state.raw(null);

  let socket = null;
  let reconnectTimer = null;
  let toastTimer = null;
  let strikeTimer = null;
  let connectionAttempt = 0;
  let lastEventSequence = 0;
  let hasReceivedState = false;
  let roomEnded = false;
  let destroyed = false;
  let sounds = {};

  if (page === "host" && (params.has("token") || hashParams.has("token"))) {
    const cleanURL = new URL(location.href);
    cleanURL.searchParams.delete("token");
    cleanURL.hash = "";
    history.replaceState({}, "", `${cleanURL.pathname}${cleanURL.search}`);
  }

  function wsURL(role) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/api/rooms/${roomCode}/socket?role=${role}`;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast = { id: crypto.randomUUID(), message };
    toastTimer = setTimeout(() => { toast = null; }, 2500);
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

  function stopSounds() {
    Object.values(sounds).forEach((sound) => {
      sound.pause();
      sound.currentTime = 0;
    });
  }

  function playSound(name) {
    const sound = sounds[name];
    if (!sound || !soundEnabled) return;
    sound.currentTime = 0;
    sound.play().catch(() => { soundEnabled = false; });
  }

  function playEvent(event) {
    if (page === "display" && event.type === "strike") {
      const count = Math.max(1, Math.min(3, Number(event.strikes) || Number(game?.teams?.[event.team]?.strikes) || 1));
      clearTimeout(strikeTimer);
      strikeEvent = { sequence: event.sequence, count };
      strikeTimer = setTimeout(() => { strikeEvent = null; }, 1000);
      playSound("wrong");
    }
    if (page === "display" && event.type === "reveal") playSound("correct");
    if (page === "display" && event.type === "sound") {
      if (event.name === "stop") stopSounds();
      else playSound(event.name);
    }
    if (page === "host" && event.type === "award") showToast(`Awarded ${event.points} points`);
  }

  function applyState(nextState, allowEvent = true) {
    const sequence = Number(nextState.eventSequence) || 0;
    const isNewEvent = allowEvent && hasReceivedState && sequence > lastEventSequence;
    game = nextState;
    hasReceivedState = true;
    lastEventSequence = Math.max(lastEventSequence, sequence);
    if (isNewEvent && nextState.lastEvent) playEvent(nextState.lastEvent);
  }

  function returnToLobby(message) {
    roomEnded = true;
    connectionAttempt += 1;
    online = false;
    game = null;
    hostToken = "";
    clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    if (page === "host" && roomCode) localStorage.removeItem(`feud-host-${roomCode}`);
    history.replaceState({}, "", page === "host" ? "/host" : "/");
    roomCode = "";
    lobbyError = message;
  }

  function handleRoomEnded(reason) {
    returnToLobby(reason === "inactive" ? "The room expired after 24 hours without host activity." : page === "host" ? "The room has ended and its data was deleted." : "The host ended this room.");
  }

  async function connect(role) {
    clearTimeout(reconnectTimer);
    const attempt = ++connectionAttempt;
    connectionMessage = "";

    try {
      if (role === "host") await claimHostAccess();
      const response = await fetch(`/api/rooms/${roomCode}/state?role=${role}`, { cache: "no-store" });
      if (attempt !== connectionAttempt || destroyed) return;
      if (response.status === 404) return returnToLobby("That room does not exist or has expired.");
      if (response.status === 403) return returnToLobby("This private host link is invalid or has expired.");
      if (!response.ok) throw new Error(`Room check returned ${response.status}`);
      applyState(await response.json(), false);
    } catch (error) {
      if (attempt !== connectionAttempt || destroyed) return;
      if (error.terminal) return returnToLobby(error.message);
      online = false;
      connectionMessage = "Can’t reach the room. Retrying…";
      reconnectTimer = setTimeout(() => connect(role), 1600);
      return;
    }

    const activeSocket = new WebSocket(wsURL(role));
    socket = activeSocket;

    activeSocket.addEventListener("open", () => {
      if (socket !== activeSocket || destroyed) return;
      online = true;
      connectionMessage = "";
    });

    activeSocket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "state") applyState(message.state);
      if (message.type === "room-ended") handleRoomEnded(message.reason);
      if (message.type === "action-error") showToast(message.error || "The host action was rejected");
    });

    activeSocket.addEventListener("close", () => {
      if (socket !== activeSocket || destroyed) return;
      online = false;
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
    } catch {
      showToast("Tap again to enable sound");
    }
  }

  onMount(() => {
    if (page === "display") {
      sounds = {
        correct: new Audio("/sfx/correct.mp3"),
        wrong: new Audio("/sfx/wrong.mp3"),
        intro: new Audio("/sfx/intro.mp3"),
        "round-win": new Audio("/sfx/round-win.mp3")
      };
      Object.values(sounds).forEach((sound) => { sound.preload = "auto"; });
    }
    if (roomCode) connect(page === "host" ? "host" : "display");

    return () => {
      destroyed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(toastTimer);
      clearTimeout(strikeTimer);
      socket?.close();
      stopSounds();
    };
  });
</script>

<svelte:head>
  <title>{page === "host" ? "Family Feud — Host" : "Family Feud — Game Board"}</title>
</svelte:head>

{#if page === "host"}
  <HostPage {roomCode} {game} {online} {connectionMessage} error={lobbyError} {send} {showToast} />
{:else}
  <DisplayPage {roomCode} {game} {connectionMessage} error={lobbyError} {soundEnabled} {strikeEvent} onEnableSounds={enableSounds} />
{/if}

<div class="sr-only" role="status" aria-live="polite">{toast?.message || ""}</div>
{#if toast}
  {#key toast.id}
    <div class="toast" aria-hidden="true">{toast.message}</div>
  {/key}
{/if}
