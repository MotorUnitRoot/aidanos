# Sample notes

This folder is invented. It is the notes folder later tickets can point at. Nothing in it comes from a person's real notes.

The notes use AidanOS's own markdown. Day notes live at `vault/log/YYYY-MM-DD.md`. The Plan note is `vault/aidanos/active-horse.md`, which is the season file the app already opens for Plan. Project notes, a week file, a Capture note, and a process map sit beside those. A few files under `vault/broken/` and two bad names in `vault/log/` are broken on purpose.

Point `AIDANOS_VAULT` at `fixtures/sample-notes/vault`. The vault is still the only store. This folder is not a database.

## How to add a case

1. Add one file under `vault/`, using the layout the app already uses.
2. Add one entry to `manifest.json` with an `id`, the `path` relative to `vault/`, and a `kind`.

That is the whole change. `sample-notes-test.mjs` reads the manifest and fails if a listed file is missing, so a case cannot be dropped while its line remains. The same test walks `vault/` and fails if a file is on disk but not listed, so a new file has to be entered too.

Kinds the folder uses: `day`, `project`, `plan`, `capture`, `week`, `map`, `broken-empty`, `broken-encoding`, `broken-front-matter`, `broken-binary`, `broken-misnamed`, `broken-impossible-day`.

Task lines follow the parser already in the app:

- open: `- [ ]`
- done: `- [x]` or `- [X]`
- the empty stub `- []`, which the paper treats as open
- the same marks with `*` or `+`, and lines indented with spaces

A time is `@09:30`, or a date and a time such as `@2026-03-20 16:45`. An `@name` is an invented handle such as `@Nim`. Dates are `YYYY-MM-DD`.

## Screenshots

`screens.json` lists each screen state. `sample-screens-test.mjs` opens the sample notes and saves a picture at 1280 and 390 pixels wide for every listed state. Pictures land in `screenshots/` (gitignored) when the test runs. If the run cannot take a picture, or a listed state is missing, the test exits with a failure. It does not report an empty or skipped run as success.

## Part two

Line cases for the external format live in `fixtures/external-format/`. They are not part of this vault.
