# Closed list

Generation may emit Keep, Already, and named Composition. System is law, not a widget. Refuse never ships. Defer waits for a later pack and is not in this closed v1.

Ordinary English names. No ticket slang.

## Foundations

These are the visual language. They live in `../foundations/tokens.css`. A vault `skin.css` may change color and type. It may not change spacing, paper width, or layout. There is no elevation catalog and no motion catalog.

### Type roles

| Role | Token / size | What it is |
| --- | --- | --- |
| Body | `--font` at the room size, about 1.08rem, line 1.8 | Prose and field values. One serif: Iowan Old Style, then Palatino, then Georgia. |
| Title | clamp 1.7rem to 2.25rem, weight 500 | The page name on paper. Same face. |
| Section head | about 1.15rem, weight 500 | A group name on paper. Not a tab. Not a second typeface. |
| Quiet label | 0.75rem, `--faint`, letter-spacing | The already-named kernel label. Uppercase, same serif. |
| Quiet | `--quiet` | Placeholders, secondary words, idle chrome. |
| Faint | `--faint` | Disabled, empty, hour marks, help. |
| Tabular | `font-variant-numeric: tabular-nums` | Number, money, time, duration, progress fraction. |

Refuse a second font for chrome. Refuse a type scale catalog beyond these roles.

### Space

Use the scale in `tokens.css`: `--space-1` (0.25rem), `--space-2` (0.5rem), `--space-3` (1rem), `--space-4` (1.5rem), `--space-5` (2.5rem), `--space-6` (4rem). The paper is `--paper` (42rem) and centered. Agenda rows are `--slot` (2rem). Hairlines are one pixel.

Refuse extra gutter catalogs, fluid-space systems, and a second column width for generated work.

### Stoic color roles

| Role | Token | Value |
| --- | --- | --- |
| Room | `--bg` | `#161513` |
| Surface | `--surface` | `#1d1c19` |
| Ink | `--ink` | `#f2eee6` |
| Quiet | `--quiet` | `#9a9488` |
| Faint | `--faint` | `#6d6960` |
| Line | `--hairline` | `#2c2a26` |
| Strong line | `--hairline-strong` | `#3e3b35` |
| Success | `--ok` | `#7a8f7a` |
| Danger | `--danger` | `#b56a5c` |

Refuse brand orange, sport underlines, a rainbow, Lightning brands, and a theme catalog.

### Radius

`--radius` is `0`. Corners stay square.

Refuse pill chrome, rounded card catalogs, and a radius scale.

### Line

`--line` is `1px`. Focus is a hairline, not a glow. Hover brightens quiet ink to ink.

### Refuse in foundations

Elevation catalogs (shadow scales, floating cards, stacked decks). Motion catalogs (easing tokens, spring sets, skeleton shimmer). Z-index systems. Theme token shops.

## Controls

True atoms. Each row has one mark.

| Control | Mark | What it is |
| --- | --- | --- |
| Hairline button | Already | One button. Get to Work, Capture thoughts, Accept, and Reject are uses, not four components. |
| Text link | Already | Today, Plan, Month, and close. No box. No underline. |
| Week card | Already | One day in the week strip. |
| Week chevron | Already | Steps the week strip. Chevron exception to icon-only. |
| Day chevron | Already | Steps one day on the paper. Chevron exception to icon-only. |
| 42rem paper | Already | The writing column. Also System: width and center are law. |
| Checkbox | Already | A tick on paper. Prefer this to a switch. |
| Hanging list | Already | A mark in the gutter. Words hang to the right. |
| Wiki link | Already | A painted note name. Disk is still `[[name]]`. |
| Quiet label | Already | Uppercase faint section label. Same serif. |
| Empty state | Already | Says Write. Not a tutorial. Not an error banner. |
| Ask strip | Already | Ask or find at the bottom of the room. |
| Search hit | Already | One result: quiet file name, ink title. Opens the same paper. |
| Half-hour agenda slot | Already | One row of the day. Two rem. |
| Drag preview | Already | The faded ghost on the slot you are over. |
| Month day | Already | One day in the month grid. Hairline mark if a note exists. |
| Saved chip | Already | Reserved nav space for Saved. Does not shove the paper. Save state uses this. |
| Door prompt bar | Already | The Door question as a search-like field. The bar plus actions is Composition. |
| Text input | Keep | One line a person can type. Hairline edge. Same serif. |
| Multiline | Keep | Several lines. No rich-text toolbar. What is saved is ordinary words. |
| Search field | Keep | A field for find. Not the Ask strip. Not the Door prompt. |
| Number | Keep | A count. Tabular numbers. Not a slider. Not a gauge. |
| Money | Keep | An amount with a currency mark. Not a ledger widget. |
| Date | Keep | A day in ordinary words or short numbers. Not a month-day cell. |
| Time | Keep | A clock time, tabular. Not an agenda slot. |
| Radio/choice | Keep | One value from a short closed list, marked like the checkbox. Exclusive. |
| Select | Keep | One value from a longer closed list. Same serif. Hairline. |
| Drag handle | Keep | The grabber for a row. Not a resize handle. |
| Tabs | Keep | Words in a row. Current is ink. Not a product shell. Not console subtabs. |
| Segmented control | Keep | Two or three hairline choices in one row. Selected uses the strong line. |
| Chip/tag | Keep | A hairline word that classifies. Not a colorful pill. Not the saved chip. |
| Person chip | Keep | A person’s name as ink or a wiki link. No avatar. No pile of faces. |
| Status word | Keep | One word in quiet ink. Not a traffic-light badge. Not a path. |
| Progress fraction | Keep | A count in words, such as 3 of 8. Not a bar. Not a ring. |
| Spinner/loading | Keep | The word Working. Not a ring. Not skeleton shimmer. |
| Tooltip/field help | Keep | Quiet help under a field. Not a dark balloon. |
| Validation line | Keep | Why this field cannot be saved. Muted danger. One line. |
| Soft notice | Keep | A quiet sentence that something happened. Not a toast stack. |
| Page message | Keep | A sentence at the top of the paper. Stronger than a soft notice. Still paper. |
| Menu | Keep | A hairline list of actions. Not a waffle. Not a utility bar. |
| Menu item | Keep | One row in a menu. Words, not an icon-only button. |
| Popover | Keep | A small hairline panel near a control. Not a second room. |
| Dialog/confirm panel | Keep | A centered hairline panel with a question. Confirm pair is Composition. |
| Sheet/drawer | Keep | A hairline panel from an edge. Not a utility bar. Not a new shell. |
| Modal scrim | Keep | The wash behind a dialog. The paper stays the product. |
| Title | Keep | The page name on paper. Same serif. |
| Section head | Keep | A group name on paper. Not the quiet label. Not a tab. |
| Separator | Keep | One pixel of hairline across the paper. Not a card shadow. |
| List row | Keep | One line in a collection: a name and one quiet fact. |
| Checkbox row | Keep | The kernel checkbox on a full row. Box is the hit. Words take the caret. |
| Table head | Keep | Quiet labels over columns. No sort-arrow chrome. No resize handles. |
| Table cell | Keep | One cell of words or tabular numbers. |
| Attachment link | Keep | A file name that opens a vault file. Not a Files tab. |
| Duration mark | Keep | How long, in faint tabular numbers, such as 45 min. |
| Place crumb | Keep | Parent path as wiki links joined by middots. Not chevron breadcrumbs. |
| Lookup field | Keep | Type to find, then commit a wiki link. Not a branded popup. |
| Stage steps | Keep | Ordered process words on paper. Current is ink. Not path chevrons. |
| Activity line | Keep | One dated line. Not a feed chrome. Not a toast. |
| Filter chip | Keep | A word that narrows a list. The word is the control. Not a filter builder. |
| Quiet sheet | Keep | A hairline panel on the same paper. No scrim. Not a second room. |
| Save state | Already | Use the saved chip. Saving, Saved, or quiet empty. Does not shove the paper. |
| Switch / toggle | Refuse | A binary fact uses the checkbox. |
| Slider | Refuse | Use number, money, or duration words. |
| Icon-only button | Refuse | Chevrons excepted. Actions have words. |
| Progress bar or ring | Refuse | Use progress fraction. |
| Skeleton shimmer | Refuse | Use empty state or spinner/loading. |
| Toast stack | Refuse | Use soft notice or page message. |
| Avatar pile | Refuse | Use person chip. |
| Traffic-light badge | Refuse | Use status word. |
| Floating action button | Refuse | Use hairline button. |
| Left icon nav rail | Refuse | Generated work stays on paper. |
| Path chevrons | Refuse | Use stage steps as words. |
| Highlights panel | Refuse | Use key facts (Composition). |
| Utility bar | Refuse | Never. |
| Console subtabs | Refuse | Use tabs as words on paper, or do not. |
| App Builder mosaic | Refuse | Never. |
| Monday rainbow | Refuse | Never. |
| Lightning brand | Refuse | Never. |
| Theme catalog | Refuse | One vault skin file may change color and type only. |
| Salesforce chrome | Refuse | Never. |
| Resize handle | Refuse | Never. |
| Board lane | Defer | Optional later pack. Not closed v1. Use list row and status word. |
| Board card | Defer | Optional later pack. Not closed v1. Use list row. |
| Timeline view | Defer | Optional later pack. Not closed v1. Use date, duration, and month day. |

### System (not widgets)

Empty Door. Vault as disk. One serif. 42rem centered paper. Stoic tokens. No second store. No theme catalog.

## Composition patterns

Named assemblies. Not new atoms. Generation may use the name; it must emit only atoms already on the list.

| Pattern | Assembles | What it is |
| --- | --- | --- |
| Key facts | Quiet label + ink values (title or body) | A short stack of named facts at the top of paper. Not a highlights panel. |
| Child list | Quiet label + hanging list or list rows | Sub-lines under a parent, on the same paper. |
| Confirm pair | Two hairline buttons | Accept and Reject, or any two uses of the same button. |
| Prompt bar / actions row | Door prompt bar + hairline buttons | The Door: the question and Get to Work / Capture thoughts on one row of actions. |
| Labeled field | Quiet label + text input, multiline, number, money, date, time, select, or lookup | A name over a field. Not its own atom. |
| Checkbox row | Already listed as Keep | Checkbox plus words on one row. Named once so generation does not invent a task chrome. |

## States

One set for the whole product. Not a motion catalog.

| State | Rule |
| --- | --- |
| Default | Cream ink on the room. Quiet chrome. Hairline edges. |
| Hover | Quiet ink brightens to ink. Hairline button border brightens to ink. |
| Focus | A hairline, not a glow. Outline uses `--ink` or `--quiet`. Offset a little. |
| Active | Ink. Strong hairline where a choice is pressed. |
| Disabled | `--faint`. No pointer. |
| Loading | Spinner/loading: the word Working. Not a ring. Not shimmer. |
| Empty | Empty state: Write. Quiet, not an error. |
| Error | Validation line or page message in `--danger`. One line. Not a toast stack. |
| Selected | `--ink` and `--hairline-strong`. Week card and month day already do this. |
| Dragging | Drag preview: faded block, dashed strong hairline. |

A checked box uses `--ok`. Saving uses the saved chip and does not shove the paper.
