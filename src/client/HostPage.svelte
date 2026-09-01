<script>
  import { onMount } from "svelte";
  import { RoomConnection } from "./room.svelte.js";
  import Toast from "./Toast.svelte";

  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const initialRoomCode = (params.get("room") || "").toUpperCase();
  let hostToken = hashParams.get("token") || params.get("token") || (initialRoomCode ? localStorage.getItem(`feud-host-${initialRoomCode}`) : "") || "";

  if (params.has("token") || hashParams.has("token")) {
    const cleanURL = new URL(location.href);
    cleanURL.searchParams.delete("token");
    cleanURL.hash = "";
    history.replaceState({}, "", `${cleanURL.pathname}${cleanURL.search}`);
  }

  const room = new RoomConnection({
    roomCode: initialRoomCode,
    role: "host",
    lobbyPath: "/host",
    beforeConnect: claimHostAccess,
    clearAccess: (code) => localStorage.removeItem(`feud-host-${code}`),
    eventMessage: (reason) => reason === "inactive" ? "The room expired after 24 hours without host activity." : "The room has ended and its data was deleted.",
    onEvent: (event) => {
      if (event.type === "award") room.showToast(`Awarded ${event.points} points`);
      if (event.type === "undo-award") room.showToast(`Returned ${event.points} points to the bank`);
    }
  });

  let roomCode = $derived(room.roomCode);
  let game = $derived(room.game);
  let online = $derived(room.online);
  let connectionMessage = $derived(room.connectionMessage);
  let error = $derived(room.error);
  let createFamilyFriendly = $state(true);
  let creating = $state(false);
  let createError = $state("");

  let displayURL = $derived(game ? `${location.origin}/?room=${encodeURIComponent(game.code)}` : "");

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

  function send(type, data = {}) {
    return room.send(type, data);
  }

  function showToast(message) {
    room.showToast(message);
  }

  async function createGame(event) {
    event.preventDefault();
    creating = true;
    createError = "";
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ familyFriendly: createFamilyFriendly })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Could not create the game.");
      }
      const result = await response.json();
      location.href = `/host?room=${encodeURIComponent(result.code)}#token=${encodeURIComponent(result.hostToken)}`;
    } catch (caught) {
      createError = caught.message || "Could not create the game.";
      creating = false;
    }
  }

  function confirmQuestionReload() {
    return confirm("Load a new question set? The current questions will leave the menu, but awarded scores will remain.");
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

  async function copyBoardLink() {
    const copied = await copyText(displayURL);
    showToast(copied ? "Display link copied" : "Could not copy link");
  }

  async function copyHostLink() {
    try {
      const response = await fetch(`/api/rooms/${roomCode}/host-link`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not create a private host link");
      const result = await response.json();
      const hostURL = `${location.origin}/host?room=${encodeURIComponent(roomCode)}#token=${encodeURIComponent(result.hostToken)}`;
      const copied = await copyText(hostURL);
      showToast(copied ? "Private host link copied" : "Could not copy link");
    } catch (caught) {
      showToast(caught.message || "Could not copy host link");
    }
  }

  function changeQuestion(event) {
    const index = Number(event.currentTarget.value);
    send("question", { index });
  }

  function changeFamilyMode(event) {
    if (!confirmQuestionReload()) {
      event.currentTarget.checked = game.familyFriendly;
      return;
    }
    send("family-mode", { enabled: event.currentTarget.checked });
  }

  function renameTeam(event, index, currentName) {
    const name = event.currentTarget.value.trim().slice(0, 24);
    if (!name) {
      event.currentTarget.value = currentName;
      return;
    }
    if (name !== currentName) send("rename-team", { index, name });
  }

  function submitTeamNameOnEnter(event) {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    event.currentTarget.blur();
  }

  onMount(() => {
    room.start();
    return () => room.destroy();
  });
</script>

<svelte:head>
  <title>Family Feud — Host</title>
</svelte:head>

{#if !roomCode}
  <section class="lobby">
    <div class="lobby-card">
      <div class="lobby-mark">H</div>
      <p class="eyebrow">Host controls</p>
      <h1>Run the room</h1>
      <p class="muted">Create a private game, open the board on a TV or projector, then control every reveal from this phone.</p>
      <form class="join-form" onsubmit={createGame}>
        <label class="toggle-row">
          <span><strong>Family-friendly questions</strong><small>Filter explicit prompts and answers</small></span>
          <input type="checkbox" bind:checked={createFamilyFriendly} />
        </label>
        <button class="primary-button" disabled={creating}>{creating ? "Creating game…" : "Create a new game"}</button>
        <a class="host-game-link" href="/">Join an existing game</a>
        {#if createError || error}<div class="form-error" role="alert">{createError || error}</div>{/if}
      </form>
    </div>
  </section>
{:else if !game}
  <section class="lobby">
    <div class="lobby-card">
      <div class="lobby-mark">H</div>
      <p class="eyebrow">Room {roomCode}</p>
      <h1>Opening controls</h1>
      <p class="muted">{connectionMessage || "Connecting securely…"}</p>
    </div>
  </section>
{:else}
  <div class={["host-shell", !online && "is-offline"]}>
    <header class="host-header">
      <div class="host-brand">Family <span>Feud</span></div>
      <div class="host-room"><span class={["connection-dot", !online && "offline"]}></span> ROOM {game.code}</div>
    </header>

    <div class="host-main">
      <section class="host-section round-setup">
        <div class="section-heading"><h2>Round setup</h2></div>
        <div class="settings-grid">
          <div>
            <span class="control-label" id="multiplier-label">Point multiplier</span>
            <div class="segmented" role="group" aria-labelledby="multiplier-label">
              {#each [1, 2, 3] as value (value)}
                <button type="button" class={["segment", game.multiplier === value && "active"]} aria-pressed={game.multiplier === value} disabled={!online} onclick={() => send("multiplier", { value })}>{value}×</button>
              {/each}
            </div>
          </div>
          <div>
            <span class="control-label" id="team-count-label">Number of teams</span>
            <div class="segmented" role="group" aria-labelledby="team-count-label">
              {#each [2, 3, 4] as count (count)}
                <button type="button" class={["segment", game.teams.length === count && "active"]} aria-pressed={game.teams.length === count} disabled={!online} onclick={() => send("team-count", { count })}>{count}</button>
              {/each}
            </div>
          </div>
          <div>
            <span class="control-label">Team names</span>
            <div class="settings-grid">
              {#each game.teams as team, index (team.color)}
                <label class="team-name-row" style:--team-color={team.color}>
                  <span class="color-dot"></span>
                  <input class="field" value={team.name} maxlength="24" aria-label={`Team ${index + 1} name`} disabled={!online} onkeydown={submitTeamNameOnEnter} onblur={(event) => renameTeam(event, index, team.name)} />
                </label>
              {/each}
            </div>
          </div>
        </div>
      </section>

      <section class="host-section display-sound-controls">
        <div class="section-heading"><h2>Display &amp; sound</h2></div>
        <div class="mini-actions">
          <button type="button" class="secondary-button" disabled={!online} onclick={() => send("sound", { name: "intro" })}>Play intro</button>
          <button type="button" class="secondary-button" disabled={!online} onclick={() => send("sound", { name: "round-win" })}>Play round win</button>
          <button type="button" class="secondary-button" disabled={!online} onclick={() => send("sound", { name: "stop" })}>Stop sounds</button>
        </div>
        <button
          type="button"
          class={["intermission-button", game.intermissionVisible && "is-visible"]}
          aria-pressed={game.intermissionVisible}
          disabled={!online}
          onclick={() => send("intermission-visibility", { visible: !game.intermissionVisible })}
        >{game.intermissionVisible ? "Show game board" : "Show intermission screen"}</button>
      </section>

      <section class="host-section gameplay">
        <div class="section-heading"><h2>Who's playing?</h2><span class="bank-value">BANK {game.roundBank}</span></div>
        <div class="team-picker">
          {#each game.teams as team, index (team.color)}
            <button type="button" class={["team-button", game.activeTeam === index && "active"]} aria-pressed={game.activeTeam === index} style:--team-color={team.color} disabled={!online} onclick={() => send("active-team", { index })}>
              <span class="team-button-name">{team.name}</span>
              <span class="team-button-meta">{team.score} PTS · {team.strikes} X</span>
            </button>
          {/each}
        </div>
        <div class="bank-actions">
          <button type="button" class="award-button" disabled={!online || game.roundBank === 0} onclick={() => send("award")}>Award bank<strong>{game.roundBank} pts</strong></button>
          <button type="button" class="secondary-button undo-award-button" disabled={!online || !game.lastAward} onclick={() => send("undo-award")}>Undo award<strong>{game.lastAward ? `${game.teams[game.lastAward.team]?.name} · ${game.lastAward.points} pts` : "Nothing to undo"}</strong></button>
        </div>
        <div class="strike-actions">
          <button type="button" class="strike-button" disabled={!online} onclick={() => send("strike")}>Add X</button>
          <button type="button" class="secondary-button" disabled={!online} onclick={() => send("undo-strike")}>Undo X</button>
        </div>
      </section>

      <section class="host-section question-selection">
        <div class="section-heading"><h2>Question</h2></div>
        <label class="control-label" for="question-select">Current question</label>
        <select class="field" id="question-select" value={game.questionIndex} disabled={!online} onchange={changeQuestion}>
          {#each game.questionTitles as title, index (title)}
            <option value={index}>{index + 1}. {title}</option>
          {/each}
        </select>
        <p class="question-preview">{game.question.prompt}</p>
        <button type="button" class={["question-visibility-button", game.questionVisible && "is-visible"]} aria-pressed={game.questionVisible} disabled={!online} onclick={() => send("question-visibility", { visible: !game.questionVisible })}>{game.questionVisible ? "Hide question from display" : "Reveal question on display"}</button>
      </section>

      <section class="host-section answers">
        <div class="section-heading"><h2>Answers</h2></div>
        <div class="answer-controls">
          {#each game.question.answers as answer, index (`${game.questionIndex}-${answer.text}`)}
            {@const textParts = String(answer.text).split("/").map((text, position) => ({ text, position }))}
            {@const ownerLabel = answer.owner?.type === "bank" ? "Bank" : answer.owner?.type === "unscored" ? "No points" : answer.owner?.type === "team" ? game.teams[answer.owner.teamIndex]?.name || `Team ${answer.owner.teamIndex + 1}` : ""}
            <div class={["answer-control-row", answer.revealed && "revealed"]}>
              <div class="answer-control">
                <span class="number">{index + 1}</span>
                <span class="text">
                  {#each textParts as part (part.position)}
                    {part.text}{#if part.position < textParts.length - 1}<span class="answer-separator">/</span>{/if}
                  {/each}
                </span>
                <span class="points">{answer.points}</span>
              </div>
              <div class="answer-control-actions">
                {#if answer.revealed}
                  <span class="answer-owner">{ownerLabel}</span>
                  <button type="button" class="answer-hide-button" aria-label={`Hide answer ${index + 1}: ${answer.text}`} disabled={!online} onclick={() => send("hide-answer", { index })}>Hide</button>
                {:else}
                  <button type="button" class="answer-score-button" aria-label={`Reveal answer ${index + 1} and add ${answer.points} points to the bank`} disabled={!online} onclick={() => send("reveal", { index })}>+ Bank</button>
                  <button type="button" class="answer-only-button" aria-label={`Reveal answer ${index + 1} without points`} disabled={!online} onclick={() => send("reveal-only", { index })}>Reveal only</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>

      <section class="host-section question-library">
        <div class="section-heading"><h2>Question library</h2><span class="muted">{game.questionCount} loaded</span></div>
        <div class="settings-grid">
          <label class="toggle-row">
            <span><strong>Family-friendly questions</strong><small>Changing this replaces the questions shown in this menu</small></span>
            <input type="checkbox" checked={game.familyFriendly} disabled={!online} onchange={changeFamilyMode} />
          </label>
          <button type="button" class="secondary-button refresh-questions-button" disabled={!online} onclick={() => { if (confirmQuestionReload()) send("refresh-questions"); }}>Load 25 new questions</button>
          <p class="host-note muted">The current questions leave this menu. Their awarded points stay in the team totals, and the new questions start blank.</p>
        </div>
      </section>

      <section class="host-section">
        <div class="section-heading"><h2>Game board</h2></div>
        <p class="host-note muted">Open this on the TV or projector. Anyone with the link sees the board, but only this private host link can control it.</p>
        <div class="manual-code"><span class="control-label">Manual room code</span><strong>{game.code}</strong></div>
        <a class="display-link" href={displayURL} target="_blank" rel="noreferrer">Open audience display ↗</a>
        <div class="mini-actions link-actions">
          <button type="button" class="secondary-button" onclick={copyBoardLink}>Copy board link</button>
          <button type="button" class="secondary-button" onclick={copyHostLink}>Copy host link</button>
        </div>
      </section>

      <section class="host-section">
        <div class="section-heading"><h2>Room controls</h2></div>
        <p class="host-note muted">Clear all scores, strikes, and revealed answers. Team names stay in place.</p>
        <button type="button" class="danger-button room-control-button" disabled={!online} onclick={() => { if (confirm("Reset all scores, strikes, and revealed answers across every question?")) send("reset"); }}>Reset entire game</button>
        <div class="end-room-control">
          <p class="host-note muted">Permanently close this room and disconnect the audience display. This cannot be undone.</p>
          <button type="button" class="danger-button room-control-button end-room-button" disabled={!online} onclick={() => { if (confirm("Permanently end this room and delete all of its data?")) send("end-room"); }}>End room permanently</button>
        </div>
      </section>
    </div>
  </div>
{/if}

<Toast toast={room.toast} />
