# Family Feud

[Play Family Feud](https://family-feud.www-edav.workers.dev) · [Host a game](https://family-feud.www-edav.workers.dev/host)

A live Family Feud-style party game built with Svelte and Cloudflare Workers. Put the game board on a TV or projector and control the entire show from the host's phone.

## What's included

- A bundled library of thousands of questions, with 25 balanced questions loaded for each game
- Family-friendly mode that filters questions with explicit prompts or answers
- Iconic game-show sound effects for correct answers, strikes, the intro, and round wins
- Separate audience display and phone-friendly host controls that stay synchronized live
- A host-controlled intermission screen for breaks before and between rounds
- Two to four named teams with scores and strikes
- Answer reveals, round bank, and 1×/2×/3× scoring
- Fresh sets of 25 questions on demand without losing team names or scores

## How to play

1. Open [the host controls](https://family-feud.www-edav.workers.dev/host) on a phone and create a room.
2. Open the audience-display link on the TV or projector, or enter the four-character room code on the home page.
3. Choose the current team, read the question aloud, then reveal the question on the display when you're ready.
4. Tap answers to reveal them, add strikes for wrong guesses, and award the round bank to the winning team.

Rooms are private to the host link and automatically expire after 24 hours without host activity. The host can also end a room immediately.

## Run locally

```bash
pnpm install
pnpm dev
```

Open `http://localhost:8787/host`, create a game, and use the audience link shown in the control panel.

Wrangler listens on all local network interfaces, so a phone on the same Wi-Fi can open `http://YOUR-COMPUTER-IP:8787/host`. Keep the terminal running while using the game.

## Verify changes

```bash
pnpm check
pnpm test
```

`pnpm check` validates the Svelte client and Worker JavaScript. The tests cover room-state actions, event sequencing, hibernation initialization, public-state privacy, question filtering, and question-bank integrity.

## Routes

- `/` — audience display (enter a room code)
- `/host` — create and control a game
- `/api/rooms` — room creation
- `/api/rooms/:code/socket` — real-time room connection
- `/api/rooms/:code/claim` — exchanges a private host-link token for a room-scoped HttpOnly cookie

The Svelte client is built with Vite, while WebSockets and Cloudflare Durable Objects provide live synchronization and room state. `public/data/questions.json` is the canonical question source; new rooms receive five random questions from each answer-count group (3–7 answers).
