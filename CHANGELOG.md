# Changelog

## [3.0.2] - 2026

### Changed
* The log strip at the bottom no longer opens just to narrate loading. "Loading conversations…" and "N chats loaded" were pushing a permanent panel into view that then sat there stealing height from the list for the rest of the session. The live count already runs in the footer while loading, and the total lands in the header when it's done
* Every job now starts with the log emptied and closed again, so a clean run leaves no strip behind and old failures don't pile up under new ones
* It still opens on its own for anything that actually matters: errors, failed rows, rate-limit retries, the page-limit warning, and the summary after a delete or archive

## [3.0.1] - 2026

### Fixed
* Installing from the Raw link worked again. The file had been renamed from `chatgpt-bulk-deleter.user.js` to `chatgpt-bulk-deleter.js`, and userscript extensions only offer the install prompt for URLs ending in `.user.js`. Everything else was fine, the Raw link just rendered as source with no way to install it
* `@homepageURL`, `@supportURL` and `@namespace` pointed at `Zorakidd/chatgpt-bulk-deleter`, a repo that does not exist, so the Homepage and Support links in the userscript dashboard led nowhere. They point at this repo now

Note: because `@namespace` changed, an already installed copy counts as a different script. Remove the old entry from your userscript dashboard after installing this one, otherwise you end up with both.

## [3.0.0] - 2026

Hardening and performance pass. Same feature set, rebuilt internals.

### Fixed
* Pagination stopped after the first page when the server left `total` out of the response. The loop is driven by the page length now, with a page cap as a backstop
* A page containing rows the script drops no longer pushes the offset past conversations it never saw
* A rate limit could consume the single token-refresh attempt, so an expired token during a long run failed the rest of the batch. Retry budgets are separate now
* `Retry-After` was applied uncapped and could not be interrupted, so Cancel did nothing for the length of the wait. It is capped, and every wait aborts on cancel
* Cancel now aborts in-flight requests instead of only stopping the next iteration
* A missing `document` keydown cleanup leaked a listener every time the SPA replaced the host
* Non-JSON responses (login redirect, interstitial) surfaced as `SyntaxError` instead of an explanation

### Performance
* Virtual list: only the visible rows exist in the DOM. 5,000 conversations went from 20,000 DOM nodes and 5,000 checkbox listeners to roughly 80 nodes and none
* Search is debounced and the filter result is cached, so typing no longer rebuilds the whole list per keystroke (~539 ms to ~0.5 ms of blocking time per keystroke at 5,000 chats, measured in jsdom)
* Deleting no longer rescans the item array and the DOM per conversation; the list is filtered once at the end
* Deletes and archives run through a small worker pool instead of strictly one at a time, with a shared cooldown so a single 429 slows every worker down
* Dates are formatted once at load time through a cached formatter, and UI updates are batched into one animation frame

### Hardened
* Runs only in the top frame, only over HTTPS, only on the expected host, and only once per document
* Conversation ids from the server are validated before they are used to build a request path
* Titles are stripped of control characters, length-capped, and only ever inserted as text
* Per-request timeout, jittered backoff, and response bodies drained before a retry
* The access token lives outside the UI state, is refreshed single-flight, and is never logged
* Confirmation moved to its own button row and stays inert briefly, so a double click cannot run straight through it
* Escape steps back out of the confirmation instead of closing the panel; the dialog traps Tab and restores focus on close
* Keyboard selection (arrows, Space, Shift-range, Ctrl+A) and screen-reader semantics for the list, progress and log
* Optional JSON export of the selection before an irreversible delete
* Follows the ChatGPT light/dark theme
* Warns before leaving the page while a run is in progress

## [2.0.0] - 2026

Initial release.

### Changed
* Chat list now comes from the API with pagination instead of the DOM, so "select all" really means all
* Two-step confirmation before deleting
* Archiving as a less permanent alternative
* Title search and select over the filtered results
* Progress indicator with a cancel button
* Rate-limit handling with exponential backoff and `Retry-After`
* Access token is refreshed automatically once on HTTP 401
* Rows only disappear on confirmed success, failures stay marked and can be reselected
* UI in a Shadow DOM, so no CSS collisions with ChatGPT

### Misc
* Auto-update disabled (`@downloadURL none`, `@updateURL none`)
