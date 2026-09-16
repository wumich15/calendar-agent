# calman

A terminal application that imports events from a web page into your Google
Calendar, and gives you a Vim-style calendar manager for the result.

```text
calman https://example.com/events     # import the events on that page
calman view                           # browse, edit, and delete your events
```

- [Requirements](#requirements)
- [Installation](#installation)
- [The system `cal` command](#the-system-cal-command)
- [Connecting your Google account](#connecting-your-google-account)
- [Importing events from a website](#importing-events-from-a-website)
- [The calendar manager](#the-calendar-manager)
- [Keyboard reference](#keyboard-reference)
- [Configuration](#configuration)
- [How your credentials are stored](#how-your-credentials-are-stored)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- Node.js 22.18 or newer (24 recommended). The project is written in TypeScript
  and runs directly on Node's built-in type stripping, so there is no build step.
- A Google account, and a Google Cloud OAuth client (free; see below).

## Installation

```bash
git clone https://github.com/wumich15/calendar-agent.git
cd calendar-agent
npm install
npm link          # puts `calman` on your PATH
```

If you would rather not link it globally, run it in place:

```bash
node bin/calman.js --help
```

## The system `cal` command

macOS, most Linux distributions, and the BSDs already ship a `/usr/bin/cal` that
prints a month calendar. This project deliberately installs itself as `calman`
so the two never collide: after `npm link` you have both, and `cal` keeps doing
what it always did.

Check what you are running with:

```bash
which -a calman
```

If `calman` is not on your `PATH` — you skipped `npm link`, or npm's global
`bin` directory is not in `PATH` — use one of these instead:

- **Call it by path.** `node /path/to/calendar-agent/bin/calman.js view`
- **Add an alias** to `~/.zshrc` or `~/.bashrc`:
  ```bash
  alias calman='node /path/to/calendar-agent/bin/calman.js'
  ```
- **Use a different name.** Symlink the binary under a name of your choosing:
  ```bash
  ln -s /path/to/calendar-agent/bin/calman.js ~/.local/bin/gcal
  ```
- **Run it through npm** from the project directory: `npm run calman -- view`

Every example below is written as `calman`; substitute whatever you chose.

## Connecting your Google account

`calman` talks to the Google Calendar API on your behalf, which means you need an
OAuth client. Google does not allow a public desktop app to ship its own secret,
so you create your own, once. It takes a few minutes and costs nothing.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (or pick an existing one).
2. Under **APIs & Services → Library**, search for **Google Calendar API** and
   enable it.
3. Under **APIs & Services → OAuth consent screen**, configure the consent
   screen. Choose **External** unless you are on Google Workspace, fill in the
   required name and email fields, and add your own Google account under **Test
   users**. You do not need to publish the app or submit it for verification to
   use it yourself.
4. Under **APIs & Services → Credentials**, choose **Create credentials → OAuth
   client ID**, and pick **Desktop app** as the application type. Copy the
   client ID and client secret.
5. Give them to `calman`, either through the environment:
   ```bash
   export CALMAN_CLIENT_ID='...apps.googleusercontent.com'
   export CALMAN_CLIENT_SECRET='...'
   ```
   or saved to the config file (which is created with owner-only permissions):
   ```bash
   calman config set client-id '...apps.googleusercontent.com'
   calman config set client-secret '...'
   ```
6. Connect your account:
   ```bash
   calman auth
   ```
   Your browser opens Google's consent page. `calman` runs a one-shot server on
   `127.0.0.1` to receive the response, exchanges it for tokens using PKCE, and
   stores them. If the browser does not open, the URL is printed for you to
   paste; `calman auth --no-browser` skips the launch entirely.

`calman` requests only the access it needs:

| Scope | Why |
| --- | --- |
| `calendar.events` | Read, create, update, and delete events |
| `calendar.calendarlist.readonly` | List the calendars you can choose between |
| `openid`, `email` | Show which account is connected |

Check the connection at any time with `calman auth --status`, and disconnect with
`calman auth --logout`, which revokes the token with Google and deletes the local
copy.

## Importing events from a website

```bash
calman https://example.com/events              # import
calman https://example.com/events --dry-run    # preview, writing nothing
```

`calman` fetches the page's HTML and reads events from it, preferring structured
markup and falling back to ordinary HTML:

1. **JSON-LD** (`<script type="application/ld+json">`) — schema.org `Event` and
   its subtypes, including events nested in `@graph`, `itemListElement`, or
   `subEvent`.
2. **Microdata** — `itemscope`/`itemtype` marking a schema.org `Event`, with
   nested `Place` and `PostalAddress` flattened into a location.
3. **hCalendar** — `.vevent` / `.h-event` with `.dtstart`, `.dtend`, `.summary`.
4. **Ordinary HTML** — `<time>` elements, with the event name taken from the
   nearest heading or link and times read from the surrounding prose. Used only
   when no structured data is present.

For each event it reads the name, start, end, time zone, location, description,
and the source URL.

### What it will not guess

`calman` does not invent scheduling information. An event with no date, or with a
date it cannot parse, is skipped and listed in the summary with the reason.
Where an interpretation is unavoidable, it is made explicitly and reported:

- A start with a date but no time is imported as an **all-day** event.
- A timed event with no end gets a **one-hour** duration.
- A page with no time zone is read in your **configured calendar time zone**.
- An end before the start is read as running **past midnight**.
- An ambiguous numeric date such as `03/04/2026` is read as month/day; pass
  `--day-first` for sites that write day/month.

Every one of these appears under "Assumptions made while reading the page".

### Duplicate prevention

Each imported event carries a private `calDedupeKey` property. Before creating
anything, `calman` asks Google whether an event with that key already exists on
the calendar. Running the same page twice therefore reports duplicates rather
than creating them.

The key is derived from a stable identifier published by the source when one
exists (schema.org `@id` or `identifier`, or the microdata `itemid`), so an event
still matches after the site rewords its own copy. Otherwise it is a digest of
the source URL plus the normalized name and times, so an event that moves is
correctly treated as a new one. If you delete an imported event in Google
Calendar, a later run imports it again.

### Example output

```text
Fetching https://riversidehall.example/whats-on
Found 4 events via JSON-LD.

Calendar: Work (America/New_York)

Imported 3:
  + Ashgrove Quartet  2026-03-04 19:30-21:45 (America/New_York)
  + Spring Craft Fair  2026-04-11 to 2026-04-12 (all day)
  + Members Preview  2026-03-10 18:00-19:00 (America/New_York)

Could not be imported (1):
  - Date To Be Announced: no start date was found, and calman does not guess dates

Assumptions made while reading the page:
  ~ Spring Craft Fair: the page gave a date with no time, so it was imported as an all-day event
  ~ Members Preview: the page gave no time zone, so America/New_York was used
  ~ Members Preview: the page gave no end time, so 60 minutes was used

Source: https://riversidehall.example/whats-on
```

### Pages that cannot be imported

Some sites build their listings in the browser with JavaScript, so the HTML the
server sends contains no events. `calman` detects this and says so rather than
reporting an empty page. Try a printable or plain-HTML version of the listing,
or the individual event's own page, which is more often server-rendered.

Page content is treated strictly as data. Text on a page is read into plain
values and never executed or interpreted as an instruction.

## The calendar manager

```bash
calman view                     # daily view (the default)
calman view --week              # weekly view
calman view --date 2026-09-15   # open on a particular date
```

The manager loads your real events for the visible range and shows the calendar
name, connected account, time zone, and current date or week range.

**Daily view** lists the day's events in order: all-day events first, then timed
events by start time. **Weekly view** adds a strip of the seven days with event
counts, then the same list grouped under a heading for each day. An event that
spans several days is listed once, under the day it starts.

Rows are marked so the state of each event is visible at a glance:

| Mark | Meaning |
| --- | --- |
| `>` | the selected event |
| `*` | has an unsaved edit |
| `x` … `[deleted]` | staged for deletion, not yet deleted |
| `#` | read-only; you cannot change this event |
| `(r)` | part of a recurring series |
| `(overlap)` | overlaps another event that day |

Nothing you do in the manager reaches Google Calendar until you save. Edits and
deletions are held locally, shown in the header as an unsaved-change count, and
can be undone with `u`. They survive switching between daily and weekly view,
moving to another date, and `:refresh`.

### Editing an event

`i` opens a labelled form for the selected event. `Tab` and `Shift+Tab` move
between fields; typed characters go into the active field rather than triggering
Normal-mode shortcuts. You can change the name, location, description, start and
end date and time, time zone, and all-day status.

- `Esc` keeps your draft and returns to Normal mode.
- Fields are validated as you type and again before saving: the name must not be
  empty, dates must be `YYYY-MM-DD`, times `HH:MM`, and the end must come after
  the start. `:w` refuses to send an invalid draft and names the problem.
- Fields you did not touch are left exactly as Google has them.
- `Space` toggles all-day, which hides the time fields.
- `Ctrl-J` inserts a line break in the description.

### Recurring events

Selecting `i` or `dd` on an occurrence of a recurring series asks whether you
mean **this occurrence** (the default, on `Enter` or `o`) or **the whole series**
(`s`). Nothing is staged until you choose. Inside the edit form, `Ctrl-S`
switches between the two. The chosen scope is shown in the form header and in
the save summary.

### Saving

`:w` writes staged changes; `:wq` writes them and quits only if every one
succeeded. Each change is sent on its own, and each one that succeeds is dropped
from the pending set immediately, so:

- A partial failure reports exactly what succeeded and what did not.
- Failed changes stay staged, ready for another `:w`.
- Retrying never repeats an operation that already went through.
- `:wq` that cannot fully save keeps the application open and shows the error.

Updates and deletions are sent with the event's `ETag`, so if someone else
changed the event in Google Calendar since you loaded it, the save is rejected as
a conflict and reported instead of overwriting their version. `:refresh` also
warns when a drafted event changed remotely, and keeps your draft either way.

## Keyboard reference

Press `?` or `:help` inside the manager for the same list.

### Normal mode

| Key | Behavior |
| --- | --- |
| `j` / `k` | Select the next or previous event |
| `h` / `l` | Previous or next day, or week in weekly view |
| `g` / `G` | Jump to the first or last event in view |
| `Enter` | Show the selected event's details |
| `t` | Jump to today |
| `i` | Edit the selected event |
| `dd` | Stage the selected event for deletion |
| `u` | Undo the most recent unsaved edit or deletion |
| `Esc` | Close an overlay, or cancel a partial `d` |
| `:` | Enter Command mode |
| `?` | Show the keyboard reference |
| `Ctrl-C` | Quit; with unsaved changes, press twice to discard them |

### Insert/Edit mode

| Key | Behavior |
| --- | --- |
| `Tab` / `Shift+Tab` | Move to the next or previous field |
| `Enter` | Move to the next field |
| `←` `→` `Home` `End` | Move within the field |
| `Backspace` / `Delete` | Delete a character |
| `Space` | Toggle the all-day field |
| `Ctrl-J` | Insert a line break in the description |
| `Ctrl-S` | Switch a recurring edit between occurrence and series |
| `Esc` | Keep the draft and return to Normal mode |

### Command mode

| Command | Behavior |
| --- | --- |
| `:day` | Switch to daily view |
| `:week` | Switch to weekly view |
| `:w` | Save pending changes to Google Calendar |
| `:wq` | Save pending changes and quit after a successful save |
| `:q` | Quit if there are no unsaved changes; otherwise warn |
| `:q!` | Discard unsaved changes and quit |
| `:refresh` | Reload events without discarding pending changes |
| `:today` | Jump to today |
| `:goto <YYYY-MM-DD>` | Jump to a date |
| `:help` | Show the keyboard reference |

Inside the help, details, and save-report overlays, `j` / `k` scroll and `Esc`
closes.

## Configuration

```bash
calman calendars                                  # list calendars you can use
calman config list                                # show current settings
calman config set calendar work@example.com       # choose a calendar
calman config set timezone Europe/Berlin          # override the display time zone
calman config set week-start monday               # start weeks on Monday
```

| Key | Meaning | Default |
| --- | --- | --- |
| `calendar` | Calendar id to read and write | `primary` |
| `timezone` | IANA zone for display and for zone-less page times | the calendar's own zone |
| `week-start` | `sunday` or `monday` | `sunday` |
| `client-id`, `client-secret` | OAuth client, if not in the environment | unset |

Single commands can override the calendar and time zone without changing the
saved configuration:

```bash
calman view --calendar work@example.com --timezone Asia/Tokyo
calman https://example.com/events --calendar personal@example.com
```

If you only have read access to a calendar, `calman` says so: the manager opens
with `[read-only]` in the header and refuses to stage edits, and an import
stops with an explanation rather than failing part-way through.

## How your credentials are stored

Configuration and credentials live in `$CALMAN_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/calman`, else `~/.config/calman`:

- `config.json` — settings, written with mode `0600`
- `tokens.json` — access and refresh tokens, written with mode `0600` inside a
  directory created with mode `0700`

Tokens are never written to logs or included in output. The access token is
refreshed automatically a minute before it expires; concurrent requests share a
single refresh. If the refresh token has been revoked or has expired, `calman`
says so and tells you to run `calman auth` again. `calman auth --logout` revokes
the token with Google and removes the local file.

## Troubleshooting

**"No Google OAuth client is configured."** — Follow
[Connecting your Google account](#connecting-your-google-account) to create a
Desktop-app client, then set `CALMAN_CLIENT_ID` and `CALMAN_CLIENT_SECRET`.

**"Google rejected the stored credentials."** or **"Could not refresh Google
access."** — The token was revoked, expired, or the OAuth client changed. Run
`calman auth` to reconnect.

**"Access blocked: calman has not completed the Google verification process."** —
Add your own Google account under **Test users** on the OAuth consent screen.

**"No events were found on …"** — The page may not mark its events up in a way
`calman` can read, or may render them with JavaScript. Try `--dry-run` on the
individual event's page, or a printable version of the listing.

**An event imported at the wrong time.** — The page probably stated no time
zone. Check the assumptions in the summary and set `calman config set timezone
<zone>`, or pass `--timezone` for one run.

**`calman: command not found`.** — See
[The system `cal` command](#the-system-cal-command). Note that the executable is
`calman`, not `cal`; plain `cal` is your operating system's month printer.

For a stack trace on an unexpected error, set `CALMAN_DEBUG=1`.

## Development

```bash
npm test          # run the test suite (node:test, no network)
npm run typecheck # tsc --noEmit
```

The code is separated so each layer can be tested on its own:

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Argument parsing and dispatch; no network or calendar work |
| `src/commands/` | One module per command, wiring the layers together |
| `src/scrape/` | Fetching (`fetch.ts`), extraction (`extract.ts`), date parsing (`datetext.ts`), normalization (`normalize.ts`) |
| `src/calendar/` | Google Calendar REST client and the import pipeline |
| `src/auth/`, `src/config/` | OAuth, token storage, settings |
| `src/tui/` | `app.ts` state machine, `render.ts` pure renderer, `draft.ts` unsaved changes, `save.ts` write-back, `keys.ts` input decoding, `screen.ts` terminal |
| `src/util/datetime.ts` | Time-zone handling, built on `Intl` |

Tests cover event extraction from each markup style, date and time-zone handling
including DST transitions, duplicate prevention, mode-specific shortcuts, staged
edits and deletions, and partial save failures. They use HTML fixtures in
`test/fixtures/` and an in-memory Google Calendar stand-in in
`test/helpers/fake-client.ts`, so the suite never touches the network.
