# Changelog

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
