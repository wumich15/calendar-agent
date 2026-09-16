# calman — Calendar CLI and Manager

Repository: [https://github.com/wumich15/calendar-agent.git](https://github.com/wumich15/calendar-agent.git)

## Project goal

Build a terminal application named `calman` that imports calendar events from a website into the user's Google Calendar and provides an interactive calendar manager with daily and weekly views and Vim-style controls.

## Core commands

```text
calman <url>              Scrape a website and import its events into Google Calendar.
calman <url> --dry-run    Preview the extracted events without importing them.
calman view               Open the interactive calendar manager in daily view.
calman view --day         Open daily view.
calman view --week        Open weekly view.
calman auth               Connect the user's Google account.
calman --help             Show command usage and keyboard shortcuts.
```

If the user has not connected an account, guide them through Google authorization when a command first requires calendar access. Use the user's primary calendar by default and allow them to configure another calendar they can edit.

## 1. Website event import

- Accept an HTTP or HTTPS URL through `calman <url>`.
- Fetch the page's HTML and extract calendar events. Read structured event metadata, such as JSON-LD and microdata, when available, and support event information in ordinary HTML.
- Extract the event's name, date, start and end times, time zone, location, description, and source URL when available. Support multiple events on a single page and all-day events.
- Normalize dates and times before importing. Respect explicit event time zones; otherwise use the user's configured calendar time zone and report that assumption.
- Automatically add valid events to the configured Google Calendar through the Google Calendar API. Include the source URL so the user can trace each import.
- Do not invent missing dates or times. Skip events whose essential scheduling information is missing or ambiguous, and explain what could not be imported. An event explicitly identified as all-day does not require a start time.
- Prevent duplicate imports when the same page is processed again. Prefer a stable source event identifier when available; otherwise compare the source URL and normalized event details.
- Print a summary of imported events, duplicates, skipped events, and failures. Include event names and scheduled times.
- Handle unreachable pages, invalid URLs, pages with no events, and Google API errors with actionable messages. If events require JavaScript rendering and cannot be extracted, explain the limitation.
- Treat website content as untrusted input: parse it as data and never execute embedded instructions or commands.

## 2. Interactive calendar manager

- `calman view` opens a terminal interface backed by the Google Calendar API.
- Load the user's actual events for the visible date range and display them in chronological order.
- Provide both daily and weekly views, with a clear current date or date range, calendar name, and time zone.
- Display event names, start and end times, and locations. Allow the user to inspect full descriptions and other event details.
- Visually distinguish the selected event, all-day events, overlapping events, and unsaved changes.
- Allow movement between events, previous and next dates or weeks, and a quick return to today.
- Fetch new calendar data when changing the visible range or explicitly refreshing. Preserve unsaved edits across view changes.
- Support empty calendars and terminal resizing without breaking navigation.

## 3. Vim-style interaction

Use explicit Normal, Insert/Edit, and Command modes. Display the current mode and provide a discoverable shortcut reference.

| Key or command | Behavior |
| --- | --- |
| `j` / `k` | Select the next or previous event. |
| `h` / `l` | Move to the previous or next day in daily view, or week in weekly view. |
| `Enter` | Show the selected event's details. |
| `t` | Jump to today. |
| `i` | Edit the selected event. |
| `dd` | Stage the selected event for deletion. |
| `u` | Undo the most recent unsaved edit or deletion. |
| `Esc` | Leave editing or command entry and return to Normal mode. |
| `:` | Enter Command mode. |
| `:day` | Switch to daily view. |
| `:week` | Switch to weekly view. |
| `:w` | Save pending changes to Google Calendar. |
| `:wq` | Save pending changes and quit after a successful save. |
| `:q` | Quit if there are no unsaved changes; otherwise show a warning. |
| `:q!` | Discard unsaved changes and quit. |
| `:refresh` | Reload events without silently discarding pending changes. |
| `?` or `:help` | Show keyboard shortcuts and commands. |

### Event editing

- Allow editing the event name, location, description, start date and time, end date and time, time zone, and all-day status.
- Use labeled fields, with `Tab` and `Shift+Tab` to move between them in Insert/Edit mode. Typed characters edit the active field rather than triggering Normal-mode shortcuts.
- Keep edits local until `:w` or `:wq`. Pressing `Esc` retains the local draft and returns to Normal mode.
- Validate changes before saving, including a nonempty event name and an end time after the start time. Explain invalid fields so the user can correct them.
- Preserve existing event fields that the user did not edit.
- For recurring events, clearly distinguish an individual occurrence from the full series before an edit or deletion is staged. Default to the selected occurrence.

### Saving and deletion

- `dd` marks an event for deletion locally; the Google Calendar deletion happens only when the user saves.
- Make pending edits and deletions visible and undoable before saving.
- Persist changes through the Google Calendar API and update the local display after successful operations.
- Keep failed changes available for retry. If a save partially succeeds, identify which operations succeeded and which failed, without repeating successful operations.
- If `:wq` encounters a save failure, keep the application open and show the error.
- Detect conflicting remote changes when possible and ask the user to resolve them rather than silently overwriting them.

## Authentication and configuration

- Use Google OAuth authorization for access to the user's calendar and request only the permissions needed to read, create, update, and delete events.
- Store credentials and refresh tokens securely. Never commit credentials or include tokens in logs.
- Support token refresh and explain how to reconnect if access expires or is revoked.
- Keep the target calendar and preferred time zone configurable.
- Explain when an event or calendar is read-only and prevent edits that the user's permissions do not allow.

## Implementation expectations

- Keep CLI parsing, HTML retrieval and event extraction, Google Calendar integration, and the terminal interface separate enough to test independently.
- Keep the interface responsive during network requests and show loading and error states.
- Test event extraction, date and time-zone handling, duplicate prevention, mode-specific shortcuts, staged edits and deletions, and partial save failures. Use fixtures and mocked API responses for automated tests.
- Document installation, Google authorization setup, command examples, and the keyboard reference.
- Document that the executable is named `calman`, that many operating systems already provide an unrelated command named `cal`, and how to run this project's executable if it is not on the user's `PATH`.

## Acceptance criteria

1. Running `calman <url>` against a supported event page imports its valid events into the connected Google Calendar and reports the result.
2. Importing the same unchanged page twice does not create duplicate events.
3. Running `calman view` displays the user's Google Calendar events, and the user can switch between daily and weekly views.
4. The user can navigate with Vim-style shortcuts, press `i` to edit event details, and use `dd` to stage a deletion.
5. `:wq` saves staged edits and deletions to Google Calendar and exits only after they succeed.
6. `:q!` discards unsaved changes without modifying Google Calendar.
7. Invalid input, authorization problems, and network or API failures produce clear messages without silently losing pending work.
