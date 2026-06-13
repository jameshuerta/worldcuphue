# World Cup 2026 — Hue Lights

Every day during the World Cup, this watches the day's matches and:

- Sets your **left lamp** to the home team's color and **right lamp** to the
  away team's color when a match kicks off.
- Moves on to the next match as soon as the current one ends.
- Flashes the **left lamp** when the home team scores, and the **right lamp**
  when the away team scores — each in that team's color — then restores the
  steady colors.
- Won't start tracking a new match after 10 PM Central (configurable). A
  match already in progress is allowed to finish normally.
- Turns both lamps off once the day's matches are done.

## Setup

```bash
cd world-cup-hue
npm install
```

`.env` is already configured with:

- `HUE_BRIDGE_IP` / `HUE_USERNAME` — copied from `nsc-hue/.env` (same bridge).
- `HUE_LIGHT_LEFT=7` (Left lamp), `HUE_LIGHT_RIGHT=5` (Right lamp).

## Usage

Run for the day (call this once, in the morning, before the first kickoff):

```bash
node watcher.js
```

It prints the day's schedule, then waits for and tracks each match in order
until the day's games are done, exiting on its own.

## Automating with Cron

World Cup group-stage matches can kick off as early as ~8 AM Pacific / 11 AM
Eastern. Start the watcher early enough to catch the first one — e.g. 7 AM
local time:

```bash
crontab -e
```

```cron
0 7 * * * cd /Users/james.huerta/Documents/Coding/world-cup-hue && /usr/local/bin/node watcher.js >> /tmp/world-cup-hue.log 2>&1
```

> **Tip:** Run `which node` to get the full path to node for the cron command.

## Configuration (.env)

| Variable             | Description                                              |
|----------------------|-----------------------------------------------------------|
| `HUE_LIGHT_LEFT`      | Light ID for the left lamp (set to home team's color)   |
| `HUE_LIGHT_RIGHT`     | Light ID for the right lamp (set to away team's color)  |
| `CUTOFF_HOUR_CT`      | Stop starting new matches after this hour, Central Time  |
| `GOAL_FLASH_PATTERN`  | `strobe` \| `pulse` \| `colorshift`                      |
| `GOAL_FLASH_COUNT`    | Number of flash cycles on a goal                          |

## Team colors

Colors come straight from ESPN's per-team `color` / `alternateColor` fields
for each match, so all 48 World Cup teams are covered automatically — no
manual color list to maintain. If a team's primary color is too close to
white or black to show up well on a bulb (e.g. England, Türkiye, Saudi
Arabia, Germany), the alternate color is used instead.

Note: a few teams share similar primary colors (lots of national teams wear
red), so some matchups may look similar on the two lamps.

## Remote API (optional)

By default this talks directly to your Hue bridge over your home network —
fine for a cron job on your home Mac. If you ever want to run it from
somewhere else (a cloud server), set up the Hue Remote API the same way as
in `nsc-hue`:

```bash
node hue-remote-setup.js
```
