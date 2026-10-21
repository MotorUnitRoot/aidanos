# Notes contract

This is the agreement for notes in AidanOS. The vault, a folder of ordinary markdown files, is the source of truth. Markdown is plain text with a few marks, such as `#` for a heading. The iPhone app, the Mac app, and the self-hosted relay keep those files in step, as the native sync design describes. The private git repository `aidanos-vault` is a backup of the markdown. That design and its try-it guide are in the open draft for native sync. This contract adds one document and leaves the apps, the relay, and the checks as they are.

AidanOS is the memory, the rules, and the approval layer for the agents that work on Colby's day. The agents keep running where they already run. They read and write notes here, they follow the rules stored here, and they wait when a change needs his yes. The rules the relay enforces live in the relay's configuration, on the relay machine, outside the vault. A note edit cannot change them. `aidanos/rules.md` is a reading copy the relay publishes from that configuration.

## Kinds of notes

The web app already sorts paths. The note route, `PUT /api/file`, refuses anything under `log/`, `tasks/`, or `aidanos/`, and it answers `kernel path`. The season plan, `aidanos/active-horse.md`, is the one file under `aidanos/` that it will save. Day files are written only by the day route, `PUT /api/day`, at `log/YYYY-MM-DD.md`. Search skips a file named `TODAY.md` and skips the rest of `aidanos/`. The folder list hides `log`, `tasks`, and `aidanos`. The native relay writes only a relative `.md` path, and it refuses a hidden name, a `..` segment, an absolute path, and a symlink that leaves the vault. It keeps a filename exactly as he wrote it. For a rule check, and for refusing a collision, it folds case and accents, as the enforcement section describes.

| Kind | Path | Purpose | Who reads it |
| --- | --- | --- | --- |
| Season plan | `aidanos/active-horse.md` | This season: title, why, next steps, and what is waiting | Colby on Plan, and every agent before it acts |
| Preferences | `aidanos/preferences.md` | How Colby wants the day handled | Agents, before they draft, and Colby |
| Team rules | `aidanos/rules.md` | The reading copy of the rules | Agents and Colby. The relay does not obey this file |
| Progress note | `progress/<slug>.md` | Where one task stopped, so the next session can continue | The next agent session, and Colby |
| Day note | `log/YYYY-MM-DD.md` | The page for that date | Colby on Today, the week cards, and agents |
| Agent log | `agent-log/YYYY-MM-DD.md` | A line added at the end, recording what an agent changed | Colby, and the next session |
| Week file | `aidanos/weeks/<Monday>.md` | Date, role, energy, mission eve, and summary for the week | The week cards on Today |
| Process map | `maps/<name>.md`, except names starting `the-` | How a kind of work proceeds. Copy the file to take the work | Colby, and an agent doing that work |
| Last-mile note | `maps/the-<name>.md` | The writing itself, such as the reply or the receipt | Colby |
| Project note | any other folder, such as `family-room-to-office/*.md` | One job: answers, plan, map, today, and walk | Colby, and the agent on that job |
| Ordinary note | `notes/<name>.md` | A captured thought that is not a day and not a job | Colby, and search |
| Proposal | `proposals/YYYY-MM-DD-<slug>.md` | A change waiting for Colby | Today, and Colby |
| Colby's own subjects | `colby/` | Pricing, contracts, clients, and public positions | Colby. Agent keys are not sent these notes |

`aidanos/skin.css` is his color and type. `family-room-to-office/plan.png` and `walk.png` are pictures he supplies. The relay writes markdown only, so it leaves those files alone. `tasks/` is locked and empty, and it stays unused, so the boxes in the notes remain the task list. The vault root `README.md` says the folder is the disk. Nothing uses the name `TODAY.md`, because search skips it. The hidden `.aidanos` folder is the edit-history cache. Git ignores it.

Standing facts are the season plan, the preferences, and the team rules. A progress note repeats the plan's four parts, then adds the resume fields below. The plan says what this season is. A progress note says where one task stopped. Day notes live in `log/`. The agent diary lives in `agent-log/`, off the day route. A project folder is any folder the table does not reserve. The family-room job shows the shape: answers that stand, marks on the drawing, stages, boxes for the day, and what a picture is allowed to claim. Wiki links connect them.

## Who may write

Colby alone writes a price, a contract, a client matter, or a public position, under `colby/`. He alone also writes preferences, the week file, and the canonical maps in `maps/`. His device key is the only key that can save those paths. The reading copy of the rules is published by the relay. His key does not edit it to change what is enforced.

An agent may write on its own when the change can be undone and needs no judgment, because the history can put the words back. On its own it may write a progress note, append a line to its log, create a draft in a project folder or under `notes/` or `maps/the-`, copy a process map into a job folder, and tick or untick a box whose words are already written. It may also append a line under a `## Suggested` heading at the end of today's day note. That line is a suggestion until he accepts it with his device key. The agent cannot write a task anywhere else on the day note, and it cannot change a suggestion after he has touched it.

His sentences stay. An agent edit that deletes words his actor inserted, or words inserted by an edit made directly in the relay folder, is refused. Ticking a box may change the box mark only. The words of the line stay. An agent edit that leaves a note empty, or leaves only whitespace, is refused. The day's front matter stays as he left it. It can hold the date, a role, an energy, mission eve, and a hard stop, and the paper hides it.

When a change cannot be undone, the agent prepares a proposal and he approves it. Sending, paying, signing, and publishing are that kind of act. The act stays where the agent already runs, and it waits for the yes. A price, a contract, a client, or a public position is facts only, with no recommendation, and he writes any words himself. The relay enforces that shape only when the target path is under `colby/`.

A judgment call on any other subject is a proposal with two or three options, and one of them is the agent's recommendation. He still picks. The season plan's title, why, and waiting list are judgments. Ticking a next step that is already written is one of the undoable changes above. An answer that stands, such as the family-room `answers.md`, is a judgment. A measurement or a claim about a room stays a draft until it has been checked against a source.

## Delete and rename

An agent cannot delete a note and cannot rename one. Both are proposals.

A delete proposal names the path and the fingerprint of the text he would be deleting. On a yes, the relay removes that file and its index entry only when the live text still matches the fingerprint. If the live text has changed, the relay does not delete. Today shows Keep mine and Take theirs. Keep mine leaves the file. Take theirs removes it.

A rename proposal names the old path, the new path, and the fingerprint. On a yes, the relay creates the note at the new path and removes the old path, only when the live text still matches the fingerprint. The new path gets the document id for that exact path. The old history stays under the old id. A new path whose folded form lands in `colby/`, the rules file, preferences, the week file, or a canonical map is not moved by the relay. He moves those himself. If the live text has changed, Today shows Keep mine and Take theirs, and the relay does not rename until he chooses.

When a delete or a rename succeeds, the relay records a retired marker for the old path: the exact spelling, the old document id, and a count. The marker sits with the relay, outside the note. A later file may reuse the spelling. It gets a new document id, the usual recipe plus that count, and the old id is refused for that path. The old text cannot merge back into the new file. It stays under the old id.

The relay tells each device that the path is gone. The device deletes its local file and drops that document from its sync list. It does not write the file back from its cache, and it does not pick the path up again.

## Proposals

A proposal is `proposals/YYYY-MM-DD-<slug>.md`. The relay accepts it from an agent key only when the fields below are filled in, then freezes it. After that freeze, an agent key cannot change the file. His device key cannot change it either, except the decision fields named below. The relay may set the status as the source ages, and it may record the apply actor after a yes. Nothing else changes.

Front matter at creation:

- `status`, starting as `waiting`
- `target`, the one note the change would touch
- `target_hash`, a fingerprint of that file's text
- `author`, the agent's name, matching its key
- `created`
- `source`, and `source_date` for when the source was produced
- `read_date`, when the agent read it
- `subject`, one of `ordinary`, `pricing`, `contract`, `client`, or `public`
- `verdict`, exactly `go ahead`, `hold`, or `needs Colby`
- `confidence`, `high`, `medium`, or `low`
- `has_claimed_figures`, `yes` or `no`
- `stale_after`, which the relay caps as described below
- `body_hash`, which the relay writes when it freezes the file

The fingerprint `body_hash` covers the proposal he will read. It leaves out the decision fields, the status, and the later apply record. His yes includes `seen_hash`, the fingerprint of the body he saw. The relay applies a yes only when `seen_hash` equals `body_hash`.

The body has a `## Figures` section. A figure is any number, date, price, size, or count the proposal relies on. Each figure is one line: the figure, either `checked` or `claimed by` a name, and the place in the source. Checked means the agent opened the source and the figure matches. Claimed means that named person or agent asserted it and it was not checked again. The name is required on every claimed line. The relay sets `has_claimed_figures` from those lines. If the field disagrees with the lines, the relay refuses the message. Any claimed figure keeps confidence at `medium` or `low`. A missing source or a missing date forces `low`. If there are no figures, the section says `None` and `has_claimed_figures` is `no`.

`go ahead` asks him to apply a `## Result`, the full text of the target after the change. `hold` asks him to wait, and it has no result to apply. `needs Colby` puts the choice in his hands. An ordinary judgment has two or three options. Each option has an id, a one-line label, and the full text of that choice. One option is marked recommended. That mark is the agent's advice, and he can pick a different option.

Facts only, with no recommendation, applies when the target is under `colby/`. The verdict is `needs Colby`. There is no `## Result`, no `## Options`, and no recommended choice. The body is the source and the figures. The relay refuses any other shape on that path. A yes records that he saw the facts. He writes any change himself. The relay does not write `colby/` from a proposal. The agent is not sent the current text of a `colby/` note, so it does not include that text, and `target_hash` on those proposals is `unavailable`. The `subject` label is whatever the agent wrote, and the relay does not trust it. Only a `colby/` path forces this shape.

The age of the source is `source_date`, not the moment the agent wrote the proposal. When the source is over 24 hours old, the relay sets `status` to `stale`. He can still decide a stale proposal until the source is 7 days old. When the source is over 7 days old, the relay sets `status` to `unusable`, and a yes does nothing. The agent may set `stale_after` earlier than 24 hours after `source_date`. If it sets a later time, or leaves the field empty, the relay stores 24 hours after `source_date`. It cannot push the 7-day line later. That line is fixed from `source_date`.

His answer uses only these fields: `decision` (`yes` or `no`), `decided_by`, `decided_at`, `option` when there are options, `seen_hash`, and `apply_choice` (`keep` or `take`) when an apply is in conflict. An agent key that writes them is refused.

On `no`, the target is unchanged. On `yes` for a `go ahead` or a chosen option, the relay writes under a fresh actor created for that proposal and records the actor on the proposal as `apply_actor`. That actor is the relay's, and a device or an agent that presents it is refused. The edit applied is the difference between the fingerprinted target and the result, not a blind replacement of the whole file. His typing outside that difference stays. If that difference overlaps an edit made after the fingerprint, the relay writes nothing and sets `apply` to `conflict`. Today then shows Keep mine and Take theirs. Keep mine leaves the live note. Take theirs replaces only the overlapping stretch with the proposal's text for that stretch, written by the proposal's apply actor, and leaves the rest of the note. Until he chooses, the note stays as it is.

## What Today needs

Today will gain a place for waiting proposals. The Designer owns how it looks. The data for each proposal is:

| Field | Meaning |
| --- | --- |
| `path` | The proposal file |
| `title` | The first heading |
| `author` | Who proposed it |
| `target` | The note that would change |
| `subject` | The agent's own label. The relay does not trust it |
| `status` | `waiting`, `stale`, `unusable`, `yes`, or `no` |
| `verdict` | `go ahead`, `hold`, or `needs Colby` |
| `confidence` | `high`, `medium`, or `low` |
| `has_claimed_figures` | `yes` or `no` |
| `source_date` | When the source was produced |
| `created` | When the proposal was written |
| `stale_after` | When the source-age rule marks it stale |
| `options` | Id and label of each option, and which one is recommended, or empty |
| `decision` | Blank, `yes`, or `no` |
| `option` | The id he picked, if he picked one |
| `seen_hash` | The fingerprint his yes carried |
| `apply` | Blank, `applied`, or `conflict` |
| `apply_choice` | Blank, `keep`, or `take` |
| `decided_at` | When he decided |

Rows with status `waiting` or `stale` are the ones still open. `unusable` and `no` leave that place. A row with `apply: conflict` is the Keep mine / Take theirs choice. Figures and the result text stay in the file, which opens in the paper Today already uses.

## Who may read

A device key receives every note, including `colby/`. An agent key receives the other notes and does not receive `colby/`. Those paths are listed in a second index that the relay sends only with a device key. The shared index agents receive has no `colby/` path. A request from an agent key for a `colby/` document, or for that second index, is refused, including when the agent has computed the document id from the path.

That protection is by path only. A price, a contract term, a client name, or a public line typed into a day note, a project note, or any other path outside `colby/` is a normal note. Agent keys receive it and can read it.

No agent runs on a machine that holds a full copy of the vault. That means the Mac notes folder, the web vault, and the relay folder. The agent sync client runs on some other machine, and it holds only the notes the relay chose to send.

The git backup is another route. After the relay is the backup writer, `aidanos-vault` contains `colby/` unless the fallback below is used. Agents that can open that repository, or read the vault token in the Google Cloud project, can read those files without a relay key. Stage 4 closes that route. The choice, and the fallback, are in the cutover section.

## Enforcement

The relay in the native draft passes each sync change through and writes the markdown. It does not yet do the checks in this section. These checks are in place before any agent key is issued. The household secret, while it still exists, stays on his devices and is not an agent key.

Agents write with the agent sync client. That client speaks the same sync protocol as the iPhone and the Mac. It holds one agent key and that key's actor id. It does not hold a device key, the household secret, or a path to the relay folder. The web app is not this client. An agent is never given an account, a mount, or a copy of the relay folder. The sync connection is its only door.

A markdown edit made directly in the relay folder is an outside edit. The relay folds it in, as the native design already does for a file changed on that machine, and the edit counts as Colby's. It is signed by the relay's local actor, which has his write rights. An agent cannot produce that edit.

On each sync message the relay does four things.

1. It decodes every Automerge change in the message. A change is the binary record of edits. Decoding reads the actor on the change and applies the edits to a scratch copy of the note. The scratch copy is kept only when every check below passes.
2. It matches each change's actor to the key that sent the message. The actor must be the one stored for that key. The relay's apply actor and its local-folder actor are never accepted from a device or an agent.
3. It compares the note before the scratch edit with the note after, including the path index, against the write rules, the read rules, and the freeze rules.
4. If any change in the message fails, the relay stores none of the message. It does not keep a passing prefix.

The filename is stored exactly as he wrote it. For a rule check, and for no other purpose, the relay folds a copy of the path: one Unicode form, capitals to lower case, and accented letters to the plain letter. `Colby/Café.md` stays stored as `Colby/Café.md`, and the folded copy is what the `colby/` rule sees. If another path folds to the same copy as a path that already exists, the relay refuses the new one. That refusal is a collision. It is not a rename, and it does not change the stored spelling.

The native design fixes the document id from the exact stored path: a fingerprint of the sentence `aidanos.note.v1` plus that path, cut to the first 16 bytes, and written as base58check. A retired path uses the same recipe with the retirement count added, so the new file does not share the old id. Every path-and-id pair is checked against that recipe. A pair that does not match fails the message. An agent cannot point `aidanos/rules.md`, or any path whose folded form is under `colby/`, at a document the agent controls. The same check covers the private index.

The scratch comparison also refuses an agent edit that empties a note, deletes his words, renames, deletes, writes a frozen proposal, sets a decision field, or writes a path the key may not write. A proposal whose claimed figures and `has_claimed_figures` disagree fails the message. A `stale_after` later than 24 hours after `source_date` is shortened by the relay rather than trusted.

When his own device has already stored a change the relay refuses, that note's sync is stuck, because the device would send the same change again. Other notes keep syncing. The screen shows the path, a short reason, and two choices: put the note back, or keep the refused text aside. Putting it back drops the refused change and takes the relay's history for that note. Keeping it aside stores the text on the device only, outside the shared index, and puts the shared note back so sync can move. He chooses one before that note syncs again. The agent sync client does not offer the aside. It puts the note back to the relay's copy and reports the refusal to the agent.

## Keys

Each device and each agent gets its own key from the relay. A device key is his hands on that iPhone or Mac and carries his write rights. An agent key carries only the agent rights above. The relay stores, with each key, a display name, a role of `colby` or `agent`, and one actor id. A phone or Mac keeps that actor in `.aidanos/actor`. The key stays in the relay's key list, outside the vault, readable only by his user, and it is not in the git backup. The history records the actor, not the key.

He revokes a key by removing it from that list. The next connection that presents it is refused before any note moves. Older edits that were already accepted keep that actor's name.

If a device loses its sync cache, it rebuilds from the markdown, as the native design describes, and it does not upload that rebuilt history over the relay. It asks the relay for the shared history. When the texts differ, he gets Keep mine, Take theirs, and Edit. If the actor file is gone and the key remains, the relay tells the device the actor stored for that key, and the device writes it back. It does not invent a second actor for the same key. If an agent client loses its cache, it takes the relay's text for each note and reports that it did so. It does not upload a rebuilt document and it does not fork one.

Rotation issues a new key and a new actor from the relay machine. The old key works until he revokes it. He revokes it after that device has sent every edit it still holds, or he accepts that anything still unsent will be refused. Recovery from a lost device key is a new device key issued on the relay machine. The notes already on the relay stay as they are. The lost key cannot be copied back off the phone.

A revoked device's offline edits never join the shared notes. The connection is refused, so the message is not decoded into the relay. The device shows that the key is revoked and lists the notes with unsent edits. He can discard them, or keep them aside on that device. To put the words into the vault he copies them with a new device key, which is a new edit by him.

## What the phone and Mac must do

The app build includes these behaviors.

- New `colby/` notes go in the private index.
- When a note is deleted or renamed, the app removes the local file and does not pick that path up again from its cache.
- Devices store the retired-path markers, so a phone that was offline during a delete or rename doesn't recreate the old document when it reconnects.
- A refused change offers to put the note back, or to keep the text aside on the device.
- Filenames stay exactly as he wrote them.

## Cutover

The web app syncs through `aidanos-vault`: it fast-forwards, then pushes. The relay pushes and does not pull, rebase, or force-push. Both must not push in the same stage. A push from a folder whose git history does not share the backup's history is refused, which is why the relay folder starts as a clone rather than as an empty folder with a new history.

Stage 1, now. The live copy is the web vault, the folder `AIDANOS_VAULT` or `vault/`. The backup writer is the web app. The relay's git push is off. There are no agent keys.

Stage 2, one copy, then the devices. At the start he lets the web app push once, so the backup matches the web vault. He then turns browser writes off and stops the web app from pushing. The relay folder is created by cloning `aidanos-vault`. That clone is the copy. It is not copied over again. From this moment the live copy is the relay vault. The iPhone and the Mac edit it through the relay. The browser does not write, so nothing from the browser can land on top of those edits later. The relay does not push yet. There are no agent keys.

This order is the choice, because the browser has already stopped when the phone and the Mac begin. The other way, copying file by file later and showing Keep mine / Take theirs wherever both sides changed, is what we would use only if a device had already edited the relay folder before this clone. In this order that has not happened.

Stage 3, the relay becomes the backup writer. The live copy stays the relay vault. He points the relay's git URL at `aidanos-vault`. The push adds commits on top of the cloned history, so the backup accepts it. He does not push a second repository, and he does not push a history that began empty. The web app stays stopped as a writer. On the hosted app, clearing the git URL and leaving the server up points it at the bundled sample notes, because that is the folder it uses when no vault URL is set. The browser is not left in that state. Whether he gives up writing from the browser, and what the browser should do instead, is an open question below.

Stage 4, agents. Before the first agent key, he rotates the vault token, puts the new token where agents cannot read it in the Google Cloud project, and removes agent access to `aidanos-vault` on GitHub. Agents can open MotorUnitRoot repositories today, and they can reach the vault token in that cloud project. The backup holds `colby/`, so a relay rule on paths does not cover this route. The backup keeps those files so a lost relay can be restored from git. The fallback, if that access cannot be taken away, is to leave `colby/` out of the backup. Those notes would then live only on the relay and his devices, with no off-machine copy.

The relay then issues agent keys. Agents write only through the agent sync client. They are not given the web app's address, its git token, a vault path, or the relay folder. No agent runs on the Mac that holds the notes folder, on the machine that holds the web vault, or on the machine that holds the relay folder. The web write routes stay off.

## Progress notes

When an agent stops, it writes `progress/<slug>.md` directly, so a fresh session can continue. The relay requires these headings, in order, and a heading may say `None`: Title, Why, Next steps, Waiting, Task, Outputs, Completed, Decisions, Open issues, and Next action. Task names the work. Outputs names the files or other results this session produced. Completed lists what is finished. Decisions lists choices already made and who made them. Open issues lists what is unresolved. Next action is one concrete step.

A fresh session reads Next action, then Open issues, then Decisions, then the four plan sections. It also reads the season plan, the preferences, and the reading copy of the rules before it changes anything else. One file is one task. A project note may link to it. Later work updates the same file, and the history keeps the earlier text.

## Undo and history

Every accepted write is an Automerge edit kept by the relay, and by each device that still has its `.aidanos` cache. The actor names who made it. Undo is a new edit that restores the earlier words. The original edit stays. He undoes an agent's edit with his device key. An agent undoes its own direct edit the same way, and that undo still may not delete his words or empty the note.

If he has typed on top of an agent edit, the undo does not wipe that typing. The relay removes the agent's words where his later edits do not touch the same stretch, and his later words stay. Where the two touch, the relay removes nothing. The screen shows Keep mine and Take theirs. Keep mine is the note as it stands. Take theirs replaces only that overlapping stretch and leaves the rest of the note, including words he typed outside it. He chooses before anything in the overlap is cut.

If a device loses `.aidanos`, the keystroke history on that device is gone. The relay's copy is the history that still names the actors. If that copy is lost too, the markdown remains. The relay commits the markdown and pushes it to `aidanos-vault` on a timer once cutover says the relay is the backup writer. `.aidanos` stays out of the backup. That git step commits and pushes. Pull, rebase, and force-push stay off. A failed push leaves sync working. `git log` and `git show` on a path show the snapshots that arrived. Putting an old snapshot back in the vault is an outside edit, counted as his, and the relay folds the difference into the history. Devices catch up through the relay.

The web app's backup can fast-forward, and it stops when two copies of one file diverge, so he can choose Keep mine, Take theirs, or Edit. That behavior stays through stage 1. At the start of stage 2 the web app stops syncing through git. A correction in the agent log is a later line. His key can still change the log. The history holds the earlier text.

## Open questions

1. When is a proposal stale? Default: the relay marks it stale when the source is over 24 hours old, and the proposal cannot be used when the source is over 7 days old. The agent may set an earlier expiry. The relay caps a later one at 24 hours after `source_date`.
2. How does a task get onto today? Default: the agent appends it under `## Suggested` on the day note, and it counts only after he accepts it with his device key. The other shape is a one-tap proposal whose only change is that line. The agent does not write it into the day's task list.
3. Where do pricing, contracts, clients, and public positions live? Default: under `colby/`, which agent keys are not sent. The relay's protection is that path only. The same words in a day note are readable by agents.
4. Where do the reading copies live, while the web note route still refuses `aidanos/` except the season plan? Default: `aidanos/preferences.md` and `aidanos/rules.md`. Agents may read both. He writes preferences with his device key once the relay is the live copy. The enforced rules stay in the relay configuration. Browser writes turn off at the start of stage 2.
5. How is a yes applied? Default: the proposal is frozen at creation, and his yes carries the fingerprint of the body he saw. The relay writes the edit under its own actor linked to that proposal, and only the change measured from the fingerprinted target. If that change overlaps a later edit, he gets Keep mine / Take theirs, and Take theirs replaces only the overlapping stretch. Facts only, with no recommendation, is enforced for a `colby/` target. The agent's subject label is not trusted.
6. One progress file per task, or per project? Default: one file per task, at `progress/<slug>.md`, with a wiki link from the project.
7. May an agent use the shared household secret before per-key checks exist? Default: no. Agent writes wait for an agent key, and for the checks in the enforcement section.
8. Should a backup commit name the actor? Default: keep today's message until keys exist, then name the actor and the paths. The key itself stays out of the message.
9. Is he willing to give up writing from the browser, and what should the browser do instead? Default: yes. Turn the web app off when its git URL comes off, so the hosted server does not fall back to the bundled sample notes and present them as the vault. He writes on the phone and the Mac. A browser that only reads the relay can wait.

## Out of scope

Running the agents, choosing their models, and making a tool for a single task stay where those agents already run. AidanOS holds the shared notes, the rules about what they may change, and Colby's approvals. The look of Today, including waiting proposals and the refusal choice, belongs to the Designer.
