# Notes contract

This is the agreement for notes in AidanOS. The vault, a folder of ordinary markdown files, is the source of truth. Markdown is plain text with a few marks, such as `#` for a heading. The iPhone app, the Mac app, and the self-hosted relay keep those files in step, as the native sync design describes. The private git repository `aidanos-vault` is a backup of the markdown. That design and its try-it guide are in the open draft for native sync. This contract adds one document and leaves the apps, the relay, and the checks as they are.

AidanOS is the memory, the rules, and the approval layer for the agents that work on Colby's day. The agents keep running where they already run. They read and write notes here, they follow the rules stored here, and they wait when a change needs his yes.

## Kinds of notes

The web app already sorts paths. The note route, `PUT /api/file`, refuses anything under `log/`, `tasks/`, or `aidanos/`, and it answers `kernel path`. The season plan, `aidanos/active-horse.md`, is the one file under `aidanos/` that it will save. Day files are written only by the day route, `PUT /api/day`, at `log/YYYY-MM-DD.md`. Search skips a file named `TODAY.md` and skips the rest of `aidanos/`. The folder list hides `log`, `tasks`, and `aidanos`. The native relay writes only a relative `.md` path, and it refuses a hidden name, a `..` segment, an absolute path, and a symlink that leaves the vault. The relay will apply the folder rules below at the moment it accepts a write, and it will keep those refusals.

| Kind | Path | Purpose | Who reads it |
| --- | --- | --- | --- |
| Season plan | `aidanos/active-horse.md` | This season: title, why, next steps, and what is waiting | Colby on Plan, and every agent before it acts |
| Preferences | `aidanos/preferences.md` | How Colby wants the day handled | Agents, before they draft |
| Team rules | `aidanos/rules.md` | Who may write what | The relay, and every agent |
| Progress note | `progress/<slug>.md` | Where one task stopped, so the next session can continue | The next agent session, and Colby |
| Day note | `log/YYYY-MM-DD.md` | The page for that date | Colby on Today, the week cards, and agents |
| Agent log | `logs/YYYY-MM-DD.md` | A line added at the end, recording what an agent changed | Colby, and the next session |
| Week file | `aidanos/weeks/<Monday>.md` | Date, role, energy, mission eve, and summary for the week | The week cards on Today |
| Process map | `maps/<name>.md`, except names starting `the-` | How a kind of work proceeds. Copy the file to take the work | Colby, and an agent doing that work |
| Last-mile note | `maps/the-<name>.md` | The writing itself, such as the reply or the receipt | Colby |
| Project note | any other folder, such as `family-room-to-office/*.md` | One job: answers, plan, map, today, and walk | Colby, and the agent on that job |
| Ordinary note | `notes/<name>.md` | A captured thought that is not a day and not a job | Colby, and search |
| Proposal | `proposals/YYYY-MM-DD-<slug>.md` | A change waiting for Colby | Today, and Colby |
| Colby's own subjects | `colby/` | Pricing, contracts, clients, and public positions | Colby |

`aidanos/skin.css` is his color and type. `family-room-to-office/plan.png` and `walk.png` are pictures he supplies. The relay writes markdown only, so it leaves those files alone. `tasks/` is locked and empty, and it stays unused, so the boxes in the notes remain the task list. The vault root `README.md` says the folder is the disk. Nothing uses the name `TODAY.md`, because search skips it. The hidden `.aidanos` folder is the edit-history cache. Git ignores it.

Standing facts are the season plan, the preferences, and the team rules. A progress note repeats the plan's four parts, then adds the resume fields in the progress section. The plan says what this season is. A progress note says where one task stopped. Day notes live in `log/`. The agent diary lives in `logs/`, off the day route, which matches the web app's refusal to write `log/` from the note route. A project folder is any folder the table does not reserve. The family-room job shows the shape: answers that stand, marks on the drawing, stages, boxes for the day, and what a picture is allowed to claim. Wiki links connect them.

## Who may write

Colby alone writes a price, a contract, a client matter, or a public position, under `colby/`. He alone also writes preferences, the team rules, the week file, and the canonical maps in `maps/`. His key is the only key that can save those paths.

An agent may write on its own when the change can be undone and needs no judgment, because the history can put the words back. On its own it may write a progress note, append a line to its log, create a draft in a project folder or under `notes/` or `maps/the-`, copy a process map into a job folder, tick or untick a box whose words are already written, and append a task line to today's day note. His sentences and the day's front matter stay as he left them. That front matter can hold the date, a role, an energy, mission eve, and a hard stop, and the paper hides it.

When a change cannot be undone, the agent prepares a proposal and Colby approves it. Sending, paying, signing, and publishing are that kind of act. The act stays where the agent already runs, and it waits for the yes. Deleting a note is decided the same way. History can restore the bytes, and dropping the work is still his call. Until the relay grows an explicit delete, the yes is the record and he removes the file.

A judgment call is a proposal with options, and he picks. The season plan's title, why, and waiting list are judgments. Ticking a next step that is already written is one of the undoable changes above. An answer that stands, such as the family-room `answers.md`, is a judgment. A measurement or a claim about a room stays a draft until it has been checked against a source. A price, a contract term, a client commitment, or a public position stays his even when it would sit inside a day note. The agent may recommend it in a proposal. He writes the words.

## Proposals

A proposal is `proposals/YYYY-MM-DD-<slug>.md`. It waits in that folder while `status` is `waiting`. The relay accepts it from an agent key only when these front-matter fields are filled in: `status`, `target` (one note path), `target_hash` (a fingerprint of that file's text), `author` (the key's name), `created`, `source`, `source_date` (when the source was produced), `read_date` (when the agent read it), `verdict` (one line), `confidence` (`high`, `medium`, or `low`), and `stale_after`.

The body has a `## Figures` section. A figure is any number, date, price, size, or count the proposal relies on. Each figure is one line: the figure, the word `checked` or `claimed`, and the place in the source. Checked means the agent opened the source and the figure matches. Claimed means the source asserts it, or the agent inferred it, and it was not checked again. Any claimed figure keeps confidence at `medium` or `low`. A missing source or a missing date forces `low`. If there are no figures, the section says `None`. The verdict line carries the confidence, in this shape: `Verdict: leave the desk clearance unchecked until the drawing is measured. Confidence: low.`

A judgment also has `## Options`. Each option has an id, a one-line label, and the full markdown that would replace the target. A proposal the relay should apply has `## Result`, the full text of the target after the change.

His yes or no is written into the same file, and only his key can write it. He sets `decision` to `yes` or `no`, `decided_by` to his name, and `decided_at` to the time. On a judgment he also sets `option` to the id he picked. Those fields, written by his key, are the approval. An agent key that sets them is refused.

On `no`, the target is unchanged and the file remains with status `no`. On `yes`, the relay applies `## Result`, or the chosen option's text, as one edit under his key, and it writes only `target`. It leaves the file to him when the target is under `colby/`, or is preferences, the rules, the week file, or a canonical map. A yes on a stale proposal changes nothing.

The relay marks a proposal `stale` when `stale_after` passes, or when the target's text no longer matches `target_hash`. It keeps the file and does not apply it. A stale file stays stale. The next attempt is a new proposal, with the evidence read again.

## What Today needs

Today will gain a place for waiting proposals. The Designer owns how it looks. The data for each proposal is:

| Field | Meaning |
| --- | --- |
| `path` | The proposal file |
| `title` | The first heading |
| `author` | Who proposed it |
| `target` | The note that would change |
| `status` | `waiting`, `yes`, `no`, or `stale` |
| `verdict` | The one-line verdict |
| `confidence` | `high`, `medium`, or `low` |
| `created` | When it was written |
| `stale_after` | When age makes it stale |
| `options` | Id and label of each option, or empty |
| `decision` | Blank, `yes`, or `no` |
| `option` | The id he picked, if he picked one |
| `decided_at` | When he decided |

Rows with status `waiting` are the ones waiting. The other statuses let a row leave that place when he answers or the proposal goes stale. Figures and the replacement text stay in the file, which opens in the paper Today already uses.

## Keys

Each device and each agent gets its own key from the relay. A device key is his hands on that iPhone or Mac and carries his write rights. An agent key carries only the rights in the section above. Today the relay checks one shared household secret in the connection header. The native design already requires a separate key per device before the relay is reachable from outside the house. Agent keys arrive at that same step. Until then the shared secret stays on his devices.

The relay stores, with each key, a display name, a role of `colby` or `agent`, and an Automerge actor id. Automerge is the history library the native design uses. The actor id is the name on each edit, and a phone or Mac keeps its own in `.aidanos/actor`. The relay accepts a change only when that actor matches the key that opened the connection. The key itself stays in the relay's list and on the device. The history records the actor.

He revokes a key by removing it from that list. The list lives outside the vault, readable only by his user, and it is not part of the git backup. The next connection with a revoked key is refused before any note moves. Older edits keep that actor's name.

On each write the relay checks the role, the path, and the shape of the bytes. It allows an agent the appends, the checkbox ticks, the drafts, and the new proposals described above, and it refuses the rest. A confidence of `high` beside a figure marked `claimed` is refused. An agent setting `decision` is refused. Hidden paths, files that are not markdown, and links that leave the vault are refused for every key. The check looks at the path, the key, and the bytes.

## Progress notes

When an agent stops, it writes `progress/<slug>.md` directly, so a fresh session can continue. The relay requires these headings, in order, and a heading may say `None`: Title, Why, Next steps, Waiting, Task, Outputs, Completed, Decisions, Open issues, and Next action. Task names the work. Outputs names the files or other results this session produced. Completed lists what is finished. Decisions lists choices already made and who made them. Open issues lists what is unresolved. Next action is one concrete step.

A fresh session reads Next action, then Open issues, then Decisions, then the four plan sections. It also reads the season plan, the preferences, and the team rules before it changes anything else. One file is one task. A project note may link to it. Later work updates the same file, and the history keeps the earlier text.

## Undo and history

Every accepted write is an Automerge edit kept by the relay, and by each device that still has its `.aidanos` cache. The actor names who made it. Undo is a new edit that restores the earlier words, and the original edit stays. He can undo an agent's edit with his device key. An agent can undo its own direct edit the same way.

If a device loses `.aidanos`, it rebuilds from the markdown and that device's keystroke history is gone. The relay's copy is the history that still names the actors. If that copy is lost too, the markdown remains.

The relay commits the markdown and pushes it to `aidanos-vault` on a timer. `.aidanos` stays out of the backup. The git step commits and pushes, and pull, rebase, and force-push stay off, so the backup's history is preserved. A failed push leaves sync working. `git log` and `git show` on a path show the snapshots that arrived. Putting an old snapshot back in the vault is an outside edit, and the relay folds that difference into the history. Devices catch up through the relay.

The web app's backup can fast-forward, and it stops when two copies of one file diverge, so he can choose Keep mine, Take theirs, or Edit against the remote copy he was shown. That behavior stays. A correction in the agent log is a later line. His key can still change the file, and the history holds the earlier text.

## Open questions

1. How soon is a proposal stale? Default: when the target changes, and also seven days after `created` if the target is untouched.
2. May an agent append an already decided task to today, with no proposal? Default: yes. The task must already be on the plan, on a map, or in a note he wrote. The relay enforces the append. The "already decided" part is a rule for the agent, because the bytes do not show it.
3. Where do pricing, contracts, clients, and public positions live? Default: under `colby/`, so a path check can protect them.
4. Where do preferences and the team rules live, while the web note route still refuses `aidanos/` except the season plan? Default: `aidanos/preferences.md` and `aidanos/rules.md`. Agents read them. He edits them on disk until that route can save them. This contract leaves the route as it is.
5. On a yes, does the relay apply `## Result`? Default: yes for an ordinary target, under his key. For `colby/`, preferences, rules, the week file, and a canonical map, the yes is only the record and he writes the file.
6. One progress file per task, or per project? Default: one file per task, at `progress/<slug>.md`, with a wiki link from the project.
7. May an agent use the shared household secret before per-key checks exist? Default: no. Agent writes wait for an agent key that the relay checks on the write.
8. Should a backup commit name the actor? Default: keep today's message until keys exist, then name the actor and the paths. The key itself stays out of the message.

## Out of scope

Running the agents, choosing their models, and making a tool for a single task stay where those agents already run. AidanOS holds the shared notes, the rules about what they may change, and Colby's approvals. The look of Today, including the place for waiting proposals, belongs to the Designer.
