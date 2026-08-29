export class RoomConnection {
  roomCode = $state("");
  game = $state.raw(null);
  online = $state(false);
  connectionMessage = $state("");
  error = $state("");
  toast = $state.raw(null);

  #role;
  #lobbyPath;
  #beforeConnect;
  #clearAccess;
  #eventMessage;
  #onEvent;
  #socket = null;
  #reconnectTimer = null;
  #toastTimer = null;
  #connectionAttempt = 0;
  #lastEventSequence = 0;
  #hasReceivedState = false;
  #roomEnded = false;
  #destroyed = false;

  constructor({ roomCode, role, lobbyPath, beforeConnect, clearAccess, eventMessage, onEvent }) {
    this.roomCode = roomCode;
    this.#role = role;
    this.#lobbyPath = lobbyPath;
    this.#beforeConnect = beforeConnect;
    this.#clearAccess = clearAccess;
    this.#eventMessage = eventMessage;
    this.#onEvent = onEvent;
  }

  start() {
    if (this.roomCode) this.#connect();
  }

  destroy() {
    this.#destroyed = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#toastTimer);
    this.#socket?.close();
    this.#socket = null;
  }

  showToast(message) {
    clearTimeout(this.#toastTimer);
    this.toast = { id: crypto.randomUUID(), message };
    this.#toastTimer = setTimeout(() => { this.toast = null; }, 2500);
  }

  send(type, data = {}) {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      this.showToast("Control is offline. Reconnecting…");
      return false;
    }
    this.#socket.send(JSON.stringify({ type, ...data }));
    return true;
  }

  #socketURL() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/api/rooms/${this.roomCode}/socket?role=${this.#role}`;
  }

  #applyState(nextState, allowEvent = true) {
    const sequence = Number(nextState.eventSequence) || 0;
    const isNewEvent = allowEvent && this.#hasReceivedState && sequence > this.#lastEventSequence;
    this.game = nextState;
    this.#hasReceivedState = true;
    this.#lastEventSequence = Math.max(this.#lastEventSequence, sequence);
    if (isNewEvent && nextState.lastEvent) this.#onEvent?.(nextState.lastEvent, nextState);
  }

  #returnToLobby(message) {
    this.#roomEnded = true;
    this.#connectionAttempt += 1;
    this.online = false;
    this.game = null;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = null;
    this.#clearAccess?.(this.roomCode);
    history.replaceState({}, "", this.#lobbyPath);
    this.roomCode = "";
    this.error = message;
  }

  #handleRoomEnded(reason) {
    this.#returnToLobby(this.#eventMessage(reason));
  }

  async #connect() {
    clearTimeout(this.#reconnectTimer);
    const attempt = ++this.#connectionAttempt;
    this.connectionMessage = "";

    try {
      await this.#beforeConnect?.();
      const response = await fetch(`/api/rooms/${this.roomCode}/state?role=${this.#role}`, { cache: "no-store" });
      if (attempt !== this.#connectionAttempt || this.#destroyed) return;
      if (response.status === 404) return this.#returnToLobby("That room does not exist or has expired.");
      if (response.status === 403) return this.#returnToLobby("This private host link is invalid or has expired.");
      if (!response.ok) throw new Error(`Room check returned ${response.status}`);
      this.#applyState(await response.json(), false);
    } catch (error) {
      if (attempt !== this.#connectionAttempt || this.#destroyed) return;
      if (error.terminal) return this.#returnToLobby(error.message);
      this.online = false;
      this.connectionMessage = "Can’t reach the room. Retrying…";
      this.#reconnectTimer = setTimeout(() => this.#connect(), 1600);
      return;
    }

    const activeSocket = new WebSocket(this.#socketURL());
    this.#socket = activeSocket;

    activeSocket.addEventListener("open", () => {
      if (this.#socket !== activeSocket || this.#destroyed) return;
      this.online = true;
      this.connectionMessage = "";
    });

    activeSocket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "state") this.#applyState(message.state);
      if (message.type === "room-ended") this.#handleRoomEnded(message.reason);
      if (message.type === "action-error") this.showToast(message.error || "The host action was rejected");
    });

    activeSocket.addEventListener("close", () => {
      if (this.#socket !== activeSocket || this.#destroyed) return;
      this.online = false;
      if (!this.#roomEnded) this.#reconnectTimer = setTimeout(() => this.#connect(), 1600);
    });
  }
}
