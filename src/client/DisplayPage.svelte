<script>
  let { roomCode, game, connectionMessage, error, soundEnabled, strikeEvent, onEnableSounds } = $props();
  let joinCode = $state("");
  let joinError = $state("");

  let answerSlots = $derived(Array.from({ length: 8 }, (_, position) => ({ position, answer: game?.question.answers[position] })));

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
</script>

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

  {#if !soundEnabled}
    <button class="sound-gate" onclick={onEnableSounds}><span>♪</span> Tap to enable game sound</button>
  {/if}

  {#if strikeEvent}
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
