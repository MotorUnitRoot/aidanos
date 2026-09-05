# Atomic library

This is a closed Library of UX atomic elements. A generator assembling any third-level / last-mile screen — support, hours, notes, commerce, a letter — may use only these atoms, the PR 6 kernel, and the named composition patterns. If the work seems to need a new control, stop. The system is wrong. The system changes first, or the screen is not shipped.

This folder is vault-side paper, not a shop, not Figma, and not a second store. The vault is the disk.

## What this is

Four layers, and nothing else:

1. **Foundations** — type roles, space, Stoic color roles, radius, line. Not an elevation catalog. Not a motion catalog.
2. **Controls** — true atoms. Each row is Keep, Refuse, Already, or System.
3. **Composition patterns** — named assemblies of atoms already on the list. Not new atoms.
4. **States** — default, hover, focus, active, disabled, loading, empty, error, selected, dragging.

`TABLE.md` is the closed list. `gallery.html` renders each Keep and Already control as one live strip on Stoic paper. The gallery is atoms, not screens.

## How this differs from the snipped draft

A closed pull request (number 7) framed CRM, ERP, and project *screen jobs* as a table: record pages, related lists, master-and-detail, issue chrome. That was the wrong object. Colby snipped it. This library does not revive that framing, does not keep a periodic-table folder, and does not name jobs by vendor screen.

This list is elements a generator can assemble. It is not a catalog of applications.

## Already set

The PR 6 kernel is closed and already shipped in `../components/`. Do not reinvent these, and do not give them a twin:

Hairline button, text link, week card, week chevron, day chevron, 42rem paper, checkbox, hanging list, wiki link, quiet label, empty state, Ask strip, search hit, half-hour agenda slot, drag preview, month day, saved chip.

The Door prompt bar is the same kernel field. The Door prompt bar with its hairline actions is a composition, not a new control.

## How to generate from this

1. Read `TABLE.md`. If the name is not Keep, Already, or a named composition, do not emit it.
2. Bind every surface to the laws: empty Door; 42rem centered paper; Stoic tokens (ink, paper, quiet, faint, line); vault as disk.
3. Load `../foundations/tokens.css` and `../components/primitives.css` for the kernel look. Match Keep atoms to the gallery strips. Do not invent a look.
4. Prefer a checkbox to a switch. Prefer a word to a badge, a bar, a ring, or a pile of faces.
5. Ordinary English names only. No ticket slang.

Open `gallery.html` in a browser to mark the atoms. Open `../components/library.html` for the kernel. Patterns in `../patterns/` assemble; they do not invent.
