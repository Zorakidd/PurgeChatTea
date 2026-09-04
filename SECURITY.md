# Security

## Access token

The most important point: your ChatGPT access token is read from your own session and only ever sent in the `Authorization` header to `chatgpt.com`.

* Never share it
* Don't post screenshots or logs where it might show up
* If it does slip out: log out in the same browser (invalidates it), then change your password

## What the script does on its side

None of this replaces reading the code, but it's what the script does to keep the blast radius small:

* It refuses to start outside the top frame, over plain HTTP, or on any host other than `chatgpt.com`, and it refuses to start twice in the same page
* Every request goes to a hard-coded path on the current origin. There is no configurable base URL and no place a redirect could point it somewhere else
* The token lives in a closure that the UI code cannot reach. It is never logged, never rendered, never written to storage
* Everything the API returns is treated as untrusted input: conversation ids are checked against a strict pattern before they are used to build a request path, titles are stripped of control characters, length-capped, and only ever inserted as text
* Error messages from the server are truncated and sanitised before they reach the log panel

## Running third-party code

This script runs with full access to your ChatGPT session. Only run it if you trust the code. It's open and readable, read it or have it read before you use it.

Only install the version from this repo or from an official source linked here. Copies from random shady sites can be tampered with.

## Found a vulnerability?

If you find a security issue, please don't open a public issue with the details. Message me directly through GitHub.
