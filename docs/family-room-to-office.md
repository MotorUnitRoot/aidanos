# Family room to office

Level 3 AidanOS app. One job: a finished family room in a US house that stays living space. Not a bedroom, a garage, or an addition. No new controls. No second store. The vault is the disk. The job has its own folder, and two writes land outside that folder.

Door prompt, exact: `What do you want to do today?`

The sentence that starts this job, exact: `I want to convert my family room to an office.`

Entering on that sentence opens Questions. `Get to Work` and `Capture thoughts` do not start this job.

## Folder

The job folder holds these files:

- `answers.md` — the eight answers
- `plan.png` — the hand drawing (or the file he dropped)
- `plan.md` — which marks are on the drawing
- `walk.png` — one picture from the doorway
- `walk.md` — what the picture is allowed to claim
- `map.md` — stages, the two forks, and the lesson for the open stage
- `today.md` — the boxes added to the day he already has

The job also writes outside that folder. `writeFamilyStops` writes the season file `aidanos/active-horse.md`. `addTheseToToday` calls `applyStepsToToday`, which writes today's `log/YYYY-MM-DD.md`. The same step also copies the boxes into `today.md`.

## Screens

Reuse only: the Door prompt, hairline buttons, paper, a hanging list, checkboxes, the process canvas, Plan blocks, the week cards, the day timeline, Ask, wiki links.

### 1. Door

Almost empty. The prompt. Two buttons: `Get to Work`, `Capture thoughts`. Enter on the sentence above is the only way into this job.

### 2. Questions

Title line is the sentence he typed. Eight lines on the paper, answered in place. Button: `These answers stand`. Link: `Not yet`.

The eight lines, in order:

1. Which room, and will anyone sleep there?
2. What must stay?
3. Will any wall or opening change?
4. Where does the desk go, and which way does the door swing?
5. What has to be plugged in, and where is the panel?
6. Supply, return, and will a new door close the room?
7. When was the house built?
8. What did the building department say?

`These answers stand` writes `answers.md` and opens the drawing. `Not yet` leaves the paper.

### 3. The drawing

Heading: `The room as it is`. The hand drawing on the paper. Checkboxes, in order:

- Overall sizes
- Door swing and window
- Desk and chair clearance
- Outlets and data jack
- Supply and return
- Walls stay. None come out.
- Where the built-in meets the floor

Button: `This drawing is the plan`. Link: `Back to the answers`.

The button writes `plan.md` from the checks and opens the walk. Unchecked lines stay unchecked. Do not invent measurements.

### 4. The walk

Heading: `From the doorway`. One picture. If a stop applies, that sentence is first, before any description of furniture.

Button: `This is the room`. Link: `Change the drawing`.

The picture is a file he supplies, or a later still. Do not generate a 3D model. Do not show open walls in the picture.

### 5. The map

Process canvas. Title: `Family room to office`. Each stage shows `Enter · Exit`. Two forks:

- `Wall stays / might carry load`
- `Surface only / open the wall`

Stages, in order: See the room, Name the use, Read the structure, the load fork, Ask the town, the surface fork, Rough, Close and finish, Final. Close and finish and Final sit on the next row. They are the same sequence, not a second process.

Opening a stage replaces the canvas. The stage paper shows why, the exit condition, then the checkboxes for that stage. It does not sit under the canvas. Button: `Add these to today`. Link: `The plan`.

### 6. Today

The day he already has. Week cards are the top row of the left column. The side rail is the day timeline. It folds at 720px.

The season block shows only on the open calendar day, and only when `today.md` has an unchecked task (`paintJobSeason`). It stays hidden on a note. When it shows, the order is:

- Why it matters.
- What comes next.
- What is waiting.
- Before you cut.

Then links: `Map`, `Drawing`. Then the boxes from `Add these to today`. The same button may appear here. It adds those boxes to today's `log/YYYY-MM-DD.md`. It does not create a new day or a new list.

## Stops

Write the stop in the walk and in the season file. Do not offer the next cut.

- Someone would sleep there. Stop.
- A wall might carry load. Do not cut it.
- Call the building department with the real scope before anything comes off the wall. The town’s answer controls the permit, not this spec.
- New or moved wiring, a bearing wall, HVAC, plumbing, and suspect lead or asbestos: licensed trade, a permit, and an inspection while the work is still visible.
- If the wall stays closed, do not open it to look.
- If the wall opens, rough work and the rough inspection happen before drywall.

## What he can learn here

Paint, flooring in the same place, casing, base, and a simple built-in.

Order when the wall was opened: prime, casing and crown, the hard floor, then base, then plates and grilles. A built-in that sits on the subfloor goes in before the floor. One that sits on the finish floor goes in after. If a permit was pulled, the final inspection is before the desk moves in.

## Out of scope

No 3D renderer. No new screen chrome. No ticket system. No second vault. Do not change DESIGN.md.
