# ChatGPT Bulk Deleter

Userscript for Tampermonkey or Violentmonkey that deletes or archives ChatGPT conversations in bulk.

The difference to most scripts of this kind: the chat list is loaded through the internal API instead of read from the DOM. So you don't have to scroll through the sidebar first just to make "select all" actually mean all.

## What it does

* Loads the chat list page by page via `/backend-api/conversations`, so even accounts with thousands of chats get all of them
* Optionally includes archived chats
* Title filter, select-all-visible over the current filter, shift-click for ranges, and keyboard selection
* Stays responsive on large accounts: only the rows you can actually see exist in the DOM, so 10,000 chats scroll like 10
* Two-step confirmation, and the destructive button stays inert for a moment so a double click can't run straight through it
* Optional JSON export of the selection, in case you want a record of what you removed
* Progress with a Cancel button that actually cancels: requests in flight are aborted and waits are cut short
* Writes run a few at a time with adaptive pacing, and a single HTTP 429 slows every worker down at once
* Honest error reporting: a row only disappears once the server confirmed the request, failed ones stay marked red and can be reselected with one click
* Rate-limit handling (429 / 5xx / network errors) with capped exponential backoff, respects `Retry-After`
* A timeout per request, so one hung connection can't wedge the whole run
* An expired access token gets refetched automatically
* Follows the ChatGPT light/dark theme, and lives in a Shadow DOM so it doesn't collide with ChatGPT's CSS

## Heads up, let's be honest for a second

This script talks to ChatGPT's internal, undocumented API instead of just clicking the buttons in the UI. Those are exactly the same calls the UI itself makes, but the endpoints aren't officially exposed for this and can change at any time. If loading suddenly breaks with an HTTP error, the endpoint probably moved.

Use at your own risk.

## Installation

1. Install Tampermonkey or Violentmonkey in your browser.
2. Open the dashboard and click "Create a new script".
3. Paste the contents of [`chatgpt-bulk-deleter.js`](./chatgpt-bulk-deleter.js) and save.
4. Open `https://chatgpt.com`. A "Clean up chats" button shows up in the bottom right corner.

Needs a reasonably current browser: Chrome or Edge 93+, Firefox 91+, Safari 15+.

## Usage

Open the panel, click "Load chats", wait until the counter at the top settles. Then filter and select, switch between Delete and Archive in the bottom right, and click through the confirmation.

Selecting:

| | |
| --- | --- |
| Click a row | Toggle it |
| Shift-click | Select or deselect the range back to the last row you clicked |
| Arrow keys | Move through the list |
| Space / Enter | Toggle the current row |
| Shift + arrows | Extend the selection |
| Ctrl / Cmd + A | Select everything the filter currently shows |
| Esc | Step back out of the confirmation, or close the panel |

The keys other than Esc need the list itself to have focus, so click a row once or tab over to it first. While the cursor is in the filter box, Ctrl+A does what it normally does there and selects the text.

"Select visible" only takes what the filter currently shows, so you can search for a word and clear out everything that matches without touching the rest.

"Include archived" only takes effect on the next load. The panel says so when you toggle it after loading.

"Export list" downloads the current selection as JSON, including the chat ids, titles and links. Deleting is not reversible, so if a record matters to you, grab it before you press the button.

Archiving is the less permanent option. The chat disappears from the sidebar but stays reachable under settings. If you're unsure about a large selection, that's the safer first step.

## What the script actually does

| Action | Request |
| --- | --- |
| Get token | `GET /api/auth/session` |
| Load list | `GET /backend-api/conversations?offset=…&limit=100&order=updated` |
| Delete | `PATCH /backend-api/conversation/{id}` with `{"is_visible": false}` |
| Archive | `PATCH /backend-api/conversation/{id}` with `{"is_archived": true}` |

These are exactly the calls the UI itself makes. At its core, the script is a robot finger that clicks for you, a lot.

## Auth token, this part matters

The access token is read from your own session (`GET /api/auth/session`) and used exclusively in the `Authorization` header of requests to `chatgpt.com`. It never leaves your browser toward any other domain, it is never written to the log panel, and it is not stored anywhere outside of memory.

Good to know: `is_visible: false` is a soft delete. The conversation disappears from your account, OpenAI removes the data in the background afterwards, usually within 30 days. If you want the history truly gone, also use the official route through account settings.

## Security

There is no contact to any domain other than `chatgpt.com`, no `eval`, no loading of external code. The script refuses to run outside the top frame, over plain HTTP, or on any host other than `chatgpt.com`. Everything the API sends back is treated as untrusted: ids are checked against a strict pattern before they are used to build a request, titles are stripped of control characters and only ever inserted as text. More detail in [SECURITY.md](./SECURITY.md).

`@downloadURL none` and `@updateURL none` disable auto-update, on purpose. A userscript with `@match *://chatgpt.com/*` sits in your logged-in session and can read your entire history and your token. A harmless version 1.0 says nothing about what an automatically pulled version 1.1 contains. So please update deliberately and skim the diff first.

The internal API is undocumented and can change at any time. If loading suddenly breaks with an HTTP error, the endpoint has probably moved.

## Contributing

Bugs, ideas, improvements are welcome. Take a quick look at [CONTRIBUTING.md](./CONTRIBUTING.md) first.

## License

MIT. See [LICENSE](./LICENSE).

## Disclaimer

This software is provided "as is", without warranty of any kind. The author is not liable for damages, account terminations, or any other consequences arising from its use. By using it, you accept that.

---

If this actually saved you some hassle and you feel like it, you can buy me a coffee. No pressure, but it's appreciated.

[☕ Ko-fi.com/zora_kidd](https://ko-fi.com/zora_kidd)
