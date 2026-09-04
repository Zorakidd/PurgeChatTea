# Contributing

Glad you want to help out.

## Found a bug?

Open an [issue](../../issues) and include:

* What you did
* What should have happened
* What happened instead
* Browser and userscript extension (Tampermonkey, Violentmonkey, ...)
* The error from the console (press F12, go to the "Console" tab)

Screenshots help. Just make sure no access token is on them.

## Got an idea or feature request?

Also as an issue, put "Idea" or "Feature" in front. Take a quick look whether it already exists.

## Contributing code

1. Fork the repo
2. Make a branch (`git checkout -b my-fix`)
3. Change it, test it
4. Open a pull request and briefly describe what and why

Roughly stick to the style that's already there. No drama over formatting, just keep it readable.

## Testing

There is no test suite in the repo, this thing runs live against ChatGPT. So: install it in your browser, try it on an unimportant account or old chats, don't go nuking your main history right away.

Before you open a PR, at least run `node --check chatgpt-bulk-deleter.user.js`. It catches the typo that would otherwise leave everyone with a dead launcher button.

Worth walking through by hand when you touch the list or the delete path:

* Load with a filter active, then delete only the filtered selection
* Cancel mid-run and check that the untouched chats are still listed
* A run where something fails (throttle yourself in devtools) and the failed rows stay marked
* Scroll a few thousand chats, since the list only renders what is on screen and index bugs hide there

## Bumping the version

The version lives in the `@version` line of the userscript header. Bump it in the same commit as the change and add a line to [CHANGELOG.md](./CHANGELOG.md), so people can tell what they are pulling before they paste it into their browser.

## Don't rename the script file

It has to stay `chatgpt-bulk-deleter.user.js`. Userscript extensions only hook a URL whose path ends in `.user.js`, so dropping that suffix quietly breaks installing from the Raw link for everyone, with no error anywhere. The file just renders as source.
