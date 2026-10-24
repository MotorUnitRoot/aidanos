# External-format cases

These are notes in the format NotePlan uses. The behavior description is not stored in this repo.

## Notes

The made-up notes are under `notes/`, with neutral file names. `manifest.json` records each note's title and where it goes:

- `notes/regular-lines.md` — ZZ REA Test Lines. New regular note in a new folder "ZZ REA Test".
- `notes/regular-frontmatter.md` — ZZ REA Frontmatter. New regular note, same folder. The property lines are the first lines of the file.
- `notes/linked-note.md` — ZZ REA Linked Note. Created by clicking the c41 link, then filled in.
- `notes/monday-text.md` — Daily note, Monday Jan 9, 2017. That day's calendar note.
- `notes/week-text.md` — Weekly note, 2017-W02 (Jan 9 to 15, 2017). That week's calendar note.
- `notes/friday-empty.md` — Daily note, Friday Jan 13, 2017. Open only, type nothing. The file is empty.

## Day notes and weekly notes

The description says there are calendar notes (one per day, and optionally per week, month, quarter, and year) and regular notes, also called project notes. Daily and weekly notes are on by default, and daily notes cannot be turned off. Monthly, quarterly, and yearly notes stay off until turned on. A line written in a weekly note shows in the references of each day of that week.

The notes show one line indented with a tab and one indented with two spaces. Whether a space indent counts the same as a tab is not settled. That waits for spec v0.3.

Day-note and weekly-note file naming and folder layout are not settled. That waits for spec v0.3. These files do not use that naming. Do not invent it.

## Cases

Active cases are the ones labeled Seen. Each case is one file under `cases/` plus an entry in `manifest.json`. The file holds the case number, the input, its context, the expected result, and the label. When the table uses a word for a character, that wording stays in `description` and `input` holds the character. A later test can read each active file and run a reader against `input` and `context`, then compare the result with `expected`. This folder does not include that reader.

Those active cases count toward the 40-case target.

Guessed and Unknown cases are listed under `pending/`. Each entry has a number, a title, and its label, and is marked "waits for spec v0.3". They have no expected result. They are not active, and they do not count toward the 40-case target.

## How to add a case

1. Add one file under `cases/` with the case number, input, context, expected result, and label.
2. Add one entry to the `active` list in `manifest.json`.

The check fails if a listed case is missing, and it fails if a case file is on disk but not listed.
