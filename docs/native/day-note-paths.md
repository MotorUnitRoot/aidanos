# Day notes: two ways of naming the file

This is a finding. It does not change where the app writes a day note, and it does not read anyone's real notes.

## What this app does today

Checked in `AidanSession.todayPath` (`native/AidanCore/Sources/AidanCore/AidanSession.swift`). For a date it builds one relative path:

`log/` plus `YYYY-MM-DD` plus `.md`

So 21 October 2026 is `log/2026-10-21.md`. The day is the Gregorian calendar day in the time zone passed to that function. `changedDay` returns the new path when that string is no longer today's path, which is how midnight is handled. The tests `testSameDayNoteCreatedTwice` and `testTodayPathChangesAtMidnight` expect this shape.

There is no `Calendar` folder in that code. A file such as `log/<some other folder>/2026-10-21.md` is just a note that happens to end in a date. It is not the path `todayPath` uses.

`NotePaths.kind` recognizes `log/YYYY-MM-DD.md` so the reader can tell a day note from any other file. It does not create files and it does not replace `todayPath`.

## What NotePlan's documentation says

Claimed, from NotePlan documentation. Not checked against a real NotePlan folder.

Daily notes and other notes live in different folders. NotePlan's help says the `Calendar` folder holds daily notes and the `Notes` folder holds everything else ([Use NotePlan with Obsidian](https://help.noteplan.co/article/61-use-noteplan-with-obsidian)). Where that pair of folders sits on a Mac (the app's local database, or an iCloud Drive folder) is described in [Where are my notes saved?](https://help.noteplan.co/article/31-where-are-my-notes-saved).

A daily note's file name is the date with no dashes, `YYYYMMDD`, for example `20161010` for 10 October 2016. The extension is `.txt` unless it has been changed. [How to migrate notes](https://help.noteplan.co/article/33-how-to-import-notes) says calendar files must be `YYYYMMDD.txt`, or the same name with whatever extension is set under Preferences, Files. The Obsidian article says the default is `.txt` and that switching the preference to `md` renames notes to `.md`, after which a daily note is recognized as `YYYYMMDD.md`. [Elements of a task](https://help.noteplan.co/article/42-elements-task) also shows a day note as `YYYYMMDD.md` and any other note as `foobar.md`.

The Obsidian importer also accepts a dashed daily name, `YYYY-MM-DD.md`, and weekly, monthly, quarterly, and yearly names ([How to import notes from Obsidian](https://help.noteplan.co/article/216-how-to-import-notes-from-obsidian)):

- week: `YYYY-Www.md`, for example `2023-W02.md`
- month: `YYYY-MM.md`
- quarter: `YYYY-Qq.md`, for example `2023-Q1.md`
- year: `YYYY.md`

Opening a week through the x-callback URL uses the same `YYYY-Www` form ([X-Callback-Url Scheme](https://help.noteplan.co/article/49-x-callback-url-scheme)). The reader treats `.md` and `.txt` as the same stems, because the extension is the preference and the stem is the documented name. A file directly inside `Calendar/` whose name is not one of these, or whose numbers are not a real date (`20240231`), is an ordinary note. A date filed under an extra folder (`Calendar/2024/20240115.md`) is not treated as a day note here. The help pages cited above show the file name, not a year subfolder.

## What has to be decided before anything reads real notes

Do not point this reader at a real NotePlan folder until the folder has been looked at and the layout is chosen. The open choice is:

- keep writing `log/YYYY-MM-DD.md`, and treat a NotePlan `Calendar/` tree as a different set of files, or
- read the existing `Calendar/YYYYMMDD.txt` or `Calendar/YYYYMMDD.md` names in place (and weekly notes, if they are there).

Those are different files. This change does not pick one, and it does not rename anything. The same pause covers the plain-marker reading (`*` as the open task, or plain `-` and `1.` as open tasks too). NotePlan's own articles describe both, and the caller has to pass one.

The made-up notes under `native/AidanCore/Tests/AidanCoreTests/SampleNotes` use the claimed NotePlan names so the reader can be tested. They are not a copy of anyone's notes, and `Notes/Plan.md` there is not the web app's `family-room-to-office/plan.md`.
