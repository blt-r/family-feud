<script>
  import { onMount } from "svelte";
  import { RoomConnection } from "./room.svelte.js";
  import Toast from "./Toast.svelte";

  const params = new URLSearchParams(location.search);
  const initialRoomCode = (params.get("room") || "").toUpperCase();

  let soundEnabled = $state(false);
  let strikeEvent = $state.raw(null);
  let joinCode = $state("");
  let joinError = $state("");
  let sounds = {};
  let strikeTimer = null;

  const room = new RoomConnection({
    roomCode: initialRoomCode,
    role: "display",
    lobbyPath: "/",
    eventMessage: (reason) => reason === "inactive" ? "The room expired after 24 hours without host activity." : "The host ended this room.",
    onEvent: handleGameEvent
  });

  let roomCode = $derived(room.roomCode);
  let game = $derived(room.game);
  let connectionMessage = $derived(room.connectionMessage);
  let error = $derived(room.error);

  let answerSlots = $derived(Array.from({ length: 8 }, (_, position) => ({ position, answer: game?.question.answers[position] })));

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

  function handleGameEvent(event, nextGame) {
    if (event.type === "strike") {
      const count = Math.max(1, Math.min(3, Number(event.strikes) || Number(nextGame?.teams?.[event.team]?.strikes) || 1));
      clearTimeout(strikeTimer);
      strikeEvent = { sequence: event.sequence, count };
      strikeTimer = setTimeout(() => { strikeEvent = null; }, 1000);
      playSound("wrong");
    }
    if (event.type === "reveal") playSound("correct");
    if (event.type === "sound") {
      if (event.name === "stop") stopSounds();
      else playSound(event.name);
    }
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
      room.showToast("Tap again to enable sound");
    }
  }

  function joinRoom(event) {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) {
      joinCode = code;
      joinError = "Use the four-character room code.";
      return;
    }
    location.href = `/?room=${encodeURIComponent(code)}`;
  }

  function fitQuestion(content) {
    return (banner) => {
      function fit() {
        if (!banner.textContent.trim()) return;
        banner.style.fontSize = "";
        let size = Number.parseFloat(getComputedStyle(banner).fontSize);
        while (banner.scrollHeight > banner.clientHeight && size > 7) {
          size -= 0.5;
          banner.style.fontSize = `${size}px`;
        }
      }

      const frame = requestAnimationFrame(fit);
      const observer = new ResizeObserver(fit);
      observer.observe(banner);
      document.fonts?.ready.then(fit);

      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    };
  }

  onMount(() => {
    sounds = {
      correct: new Audio("/sfx/correct.mp3"),
      wrong: new Audio("/sfx/wrong.mp3"),
      intro: new Audio("/sfx/intro.mp3"),
      "round-win": new Audio("/sfx/round-win.mp3")
    };
    Object.values(sounds).forEach((sound) => { sound.preload = "auto"; });
    room.start();

    return () => {
      clearTimeout(strikeTimer);
      stopSounds();
      room.destroy();
    };
  });
</script>

<svelte:head>
  <title>Family Feud — Game Board</title>
</svelte:head>

{#if !roomCode}
  <section class="lobby">
    <div class="lobby-card">
      <div class="lobby-mark">F</div>
      <p class="eyebrow">Audience display</p>
      <h1>Ready for the face-off?</h1>
      <p class="muted">Enter the room code shown on the host's phone to put this screen in the game.</p>
      <form class="join-form" onsubmit={joinRoom}>
        <input class="code-input" name="code" minlength="4" maxlength="4" placeholder="FEUD" aria-label="Four-character room code" autocomplete="off" bind:value={joinCode} oninput={() => (joinError = "")} required />
        <button class="primary-button">Open game board</button>
        <a class="host-game-link" href="/host">Host a game</a>
        {#if joinError || error}<div class="form-error" role="alert">{joinError || error}</div>{/if}
      </form>
    </div>
  </section>
{:else if !game}
  <section class="lobby">
    <div class="lobby-card">
      <div class="lobby-mark">F</div>
      <p class="eyebrow">Room {roomCode}</p>
      <h1>Warming up the board</h1>
      <p class="muted">{connectionMessage || "Connecting to the host…"}</p>
    </div>
  </section>
{:else}
  {#if game.intermissionVisible}
    <main class="intermission-stage">
      <div class="intermission-rays" aria-hidden="true"></div>
      <div class="intermission-sparkles" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <h1 class="intermission-logo" aria-label="Family Feud">
        <span class="logo-family">Family</span>
        <span class="logo-feud">Feud</span>
      </h1>
    </main>
  {:else}
    <div class="game-stage">
      <section class="stage-content">
        <div class="question-slot">
          <div class="question-banner" aria-hidden={!game.questionVisible} {@attach fitQuestion(game.questionVisible ? game.question.prompt : "")}>{game.questionVisible ? game.question.prompt : ""}</div>
        </div>
        <div class="bank-board"><strong>{game.roundBank}</strong></div>
        <div class="answer-board" style:--answer-rows={4}>
          {#each answerSlots as slot (slot.position)}
            {#if slot.answer}
              {@const answer = slot.answer}
              {@const textParts = String(answer.text || "").split("/").map((text, position) => ({ text, position }))}
              <div class={["answer-tile", answer.revealed && "is-revealed"]}>
                <div class="answer-face answer-hidden"><span class="answer-number">{slot.position + 1}</span><span></span><span></span></div>
                <div class="answer-face answer-revealed">
                  <span></span>
                  <span class="answer-text">
                    {#each textParts as part (part.position)}
                      {part.text}{#if part.position < textParts.length - 1}<span class="answer-separator">/</span>{/if}
                    {/each}
                  </span>
                  <span class="answer-points">{answer.points ?? ""}</span>
                </div>
              </div>
            {:else}
              <div class="answer-tile answer-placeholder" aria-hidden="true"></div>
            {/if}
          {/each}
        </div>
      </section>
      <footer class="teams-strip" style:--team-count={game.teams.length}>
        {#each game.teams as team, index (team.color)}
          <div class={["team-score", game.activeTeam === index && "active"]} style:--team-color={team.color}>
            <div>
              <div class="team-name">{team.name}</div>
              <div class="team-status" aria-label={`${team.strikes} strikes`}>{"X".repeat(team.strikes)}</div>
            </div>
            <div class="score-number">{team.score}</div>
          </div>
        {/each}
      </footer>
    </div>
  {/if}

  {#if !soundEnabled}
    <button class="sound-gate" onclick={enableSounds}><span>♪</span> Tap to enable game sound</button>
  {/if}

  {#if strikeEvent && !game.intermissionVisible}
    {#key strikeEvent.sequence}
      <div class="strike-overlay" aria-hidden="true">
        <div class="strike-x-group" data-count={strikeEvent.count} style:--strike-count={strikeEvent.count}>
          {#each Array.from({ length: strikeEvent.count }, (_, index) => index + 1) as strike (strike)}
            <div class="giant-x">X</div>
          {/each}
        </div>
      </div>
    {/key}
  {/if}
{/if}

<Toast toast={room.toast} />
