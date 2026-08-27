# Family Face-Off

A real-time Family Feud-style game built for Cloudflare Workers. The audience board runs on a TV or projector, while the host controls questions, answers, teams, strikes, and scores from a phone.

## Features

- Separate audience display and mobile host control panel
- Live synchronization over WebSockets
- Persistent room state with Cloudflare Durable Objects
- Automatic room deletion after 24 hours without host activity
- Two to four named teams with scores and strikes
- Answer reveals, round bank, and 1×/2×/3× scoring
- Audience-display sound effects for correct answers, strikes, intro, and round wins
- Twenty-five balanced random questions per room from the bundled JSON question bank
- Family-friendly mode that excludes questions flagged for explicit prompts or answers
- Manual question-bank refresh that preserves team names and total scores
- Private host links and shareable display room codes
- HttpOnly host authentication, collision-safe six-character room codes, and room-creation rate limiting

## Run locally

```bash
pnpm install
pnpm dev
```

Open `http://localhost:8787/host.html`, create a game, and use the audience link shown in the control panel.

Wrangler listens on all local network interfaces, so a phone on the same Wi-Fi can open `http://YOUR-COMPUTER-IP:8787/host.html`. Keep the terminal running while using the game.

## Verify changes

```bash
pnpm check
pnpm test
```

`pnpm check` validates the JavaScript and the canonical JSON question bank. The tests cover room-state actions, event sequencing, hibernation initialization, public-state privacy, question filtering, and data integrity.

## Routes

- `/` — audience display (enter a room code)
- `/host.html` — create and control a game
- `/api/rooms` — room creation
- `/api/rooms/:code/socket` — real-time room connection
- `/api/rooms/:code/claim` — exchanges a private host-link token for a room-scoped HttpOnly cookie

Rooms refresh their 24-hour expiration whenever the host performs an action. The host can also permanently end a room immediately from the control panel. `public/data/questions.json` is the canonical question source; new rooms receive five random questions from each answer-count group (3–7 answers). Run `pnpm data:clean` after importing new JSON and `pnpm data:check` before deployment.
