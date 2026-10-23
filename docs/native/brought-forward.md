# Brought forward

Pure functions over notes that have already been read. They do not write. The default mode is `everyOpenTaskFromEarlierDays`: open tasks come forward on their own and keep their move count. The caller can pass `onlyTasksMovedForward` to list only the tasks he marked moved.

The day is the calendar day of the instant in the time zone the caller passes. The machine's zone is not used. "Today" below means that day.

## Rules, in both modes

1. **Last 30 days.** An open task is listed only when it sits on a daily note strictly before today and no more than 30 calendar days before today. The day 30 days back is included. Today is not. A day note older than that is not a source. It can still supply a `[>]` mark or a done line. See `BroughtForward.lookbackDays`.

2. **Done and cancelled are out.** A ticked line and a cancelled line are not listed. If the same task text is ticked or cancelled in any note in the set, including a project note, the open copies are not listed either. Task text is the words after the bullet and checkbox, with schedule markers and `@done(...)` removed.

3. **A later date stays on that later day.** An open task with `>YYYY-MM-DD` after today is not listed. `>today`, and a `>YYYY-MM-DD` on or before today, are not "after today". Week words such as `>Friday` are not this test.

4. **The original line stays as it was.** Each item carries the note path, the 1-based line number, and that line's exact text. A later tick can find that line and change it. This function does not.

5. **Move count.** Calendar days from the shown day note to today, plus the number of `[>]` lines with the same task text on day notes earlier than that day. A mark older than 30 days still counts. A task from yesterday with no `[>]` has a count of 1. A task moved twice, shown from a day three days ago, has a count of 3 + 2.

6. **Once, from the newest day.** The same task text on several day notes is returned once, from the newest of those days, with that line's text.

Groups are newest day first. Tasks from the same day stay in line order.

## How the two modes differ

Both modes run all six rules, and both use the same move-count formula.

`everyOpenTaskFromEarlierDays` is the default. It keeps every open task that survives the rules. A task that was never marked `[>]` is still listed. Its count is only how many days it has waited.

`onlyTasksMovedForward` is the other setting. It drops any task whose earlier-note `[>]` count is zero. Waiting is not enough. He has to have marked the task moved.

## Project tasks due today

Not filtered by the mode or by the 30 days. An open task in a note that is not a daily note (a project note, the Plan note, or a weekly note) with `>YYYY-MM-DD` equal to today, or with `>today`. Each one carries the same kind of source line. A done line, a cancelled line, and a `[>]` line are not included. Whether a weekly note belongs under "From your projects" on the screen is a reading of "not a daily note". The sample includes one so the choice is visible.
