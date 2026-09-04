# Security

## Access token

The most important point: your ChatGPT access token is read from your own session and only ever sent in the `Authorization` header to `chatgpt.com`.

* Never share it
* Don't post screenshots or logs where it might show up
* If it does slip out: log out in the same browser (invalidates it), then change your password

## Running third-party code

This script runs with full access to your ChatGPT session. Only run it if you trust the code. It's open and readable, read it or have it read before you use it.

Only install the version from this repo or from an official source linked here. Copies from random shady sites can be tampered with.

## Found a vulnerability?

If you find a security issue, please don't open a public issue with the details. Message me directly through GitHub.
