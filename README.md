# ChatGPT Bulk Deleter

Userscript for Tampermonkey or Violentmonkey that deletes or archives ChatGPT conversations in bulk.

The difference to most scripts of this kind: the chat list is loaded through the internal API instead of read from the DOM. So you don't have to scroll through the sidebar first just to make "select all" actually mean all.

## What it does

* Loads the chat list page by page via `/backend-api/conversations`, including pagination, so even accounts with thousands of chats get all of them
* Optionally includes archived chats
* Title search and select-all-visible over the current filter
* Two-step confirmation so a misclick doesn't wipe half your history
* Progress indicator with a cancel button
* Honest error reporting: a row only disappears once the server actually confirmed the request, failed ones stay marked red and can be reselected with one click
* Rate-limit handling (HTTP 429 / 5xx) with exponential backoff, respects the `Retry-After` header
* An expired access token gets refetched once automatically
* UI lives in a Shadow DOM, so it doesn't collide with ChatGPT's CSS

## Heads up, let's be honest for a second

This script talks to ChatGPT's internal, undocumented API instead of just clicking the buttons in the UI. Those are exactly the same calls the UI itself makes, but the endpoints aren't officially exposed for this and can change at any time. If loading suddenly breaks with an HTTP error, the endpoint probably moved.

Use at your own risk.

## Installation

1. Install Tampermonkey or Violentmonkey in your browser.
2. Open the dashboard and click "Create a new script".
3. Paste the contents of [`chatgpt-bulk-deleter.user.js`](./chatgpt-bulk-deleter.user.js) and save.
4. Open `https://chatgpt.com`. A "Clean up chats" button shows up in the bottom right corner.

## Usage

Open the panel, click "Load chats", wait until the counter at the top settles. Then filter and select, switch between Delete and Archive in the bottom right, and click through the confirmation.

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

The access token is read from your own session (`GET /api/auth/session`) and used exclusively in the `Authorization` header of requests to `chatgpt.com`. It never leaves your browser toward any other domain.

Good to know: `is_visible: false` is a soft delete. The conversation disappears from your account, OpenAI removes the data in the background afterwards, usually within 30 days. If you want the history truly gone, also use the official route through account settings.

## Security

There is no contact to any domain other than `chatgpt.com`, no `eval`, no loading of external code. More detail in [SECURITY.md](./SECURITY.md).

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
