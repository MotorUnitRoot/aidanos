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
| Save state | Already | Use the saved chip. Saving, Saved, or quiet empty. Does not shove the paper. |
| Switch / toggle | Refuse | A binary fact uses the checkbox. |
| Slider | Refuse | Use number, money, time, and skip or jump hairline buttons. Not a scrub bar. |
| Reaction kit | Refuse | Never. A letter uses log activity and a hairline button. |
| Chart zoo | Refuse | A number is a labeled field or key fact. A register is a data table. Empty is Write. |
| Stepper | Refuse | Use number. |
| Icon-only button | Refuse | Chevrons excepted. Actions have words. |
| Badge count | Refuse | Use a quiet number or progress fraction. |
| Progress bar or ring | Refuse | Use progress fraction. |
| Skeleton shimmer | Refuse | Use empty state or spinner/loading. |
| Toast stack | Refuse | Use soft notice or page message. |
| Avatar pile | Refuse | Use person chip. |
| Presence dot | Refuse | Never. |
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
| Board column | Defer | Same later pack as board lane. |
| Board slip | Defer | Same later pack as board card. |
| Timeline view | Defer | Optional later pack. Not closed v1. Use date, duration mark, and month day. |

### System (not widgets)

Empty Door. Vault as disk. One serif. 42rem centered paper. Stoic tokens. No second store. No theme catalog. The operating system file dialog is System. Do not skin it.

Keep is closed at thirty-four atoms. Do not add a Keep atom to cover a surface. Compose, or refuse.

## Composition patterns

Named assemblies. Not new atoms. Generation may use the name; it must emit only atoms already on the list.

| Pattern | Assembles | What it is |
| --- | --- | --- |
| Labeled field | Quiet label + a Keep field | A name over a field. Not its own atom. |
| Key facts | Quiet label + ink values | A short stack of named facts. Not a highlights panel. |
| Place crumb | Wiki links + middots | Parent path on paper. Not chevron breadcrumbs. |
| Related strip | Wiki links in a row | Other notes this one needs. |
| Association line | Person chip or wiki link + a quiet fact | Who or what this line belongs with. |
| Activity line | Faint date + body | One dated line. Not a feed chrome. |
| Log activity | Several activity lines | A short chronicle on the same paper. |
| Stage steps | Body words; current is ink | Ordered process words. Not path chevrons. |
| Week cards | Week card + week chevron | The week strip. Already in the kernel. |
| Prompt bar / actions row | Door prompt bar + hairline buttons | The Door question and its two actions. |
| Save state | Saved chip | Saving, Saved, or quiet empty. Does not shove the paper. |
| Lookup field | Search field + search hit + wiki link | Type to find, then commit a wiki link. |
| Line-item sheet | Quiet sheet + table head + table cell | Header facts and lines on one paper panel. |
| Data table | Table head + list row or table cell | A register on paper. Not a grid chrome. |
| Bulk bar | Progress fraction or quiet count + hairline buttons | Work on several rows. Words, not a toolbar island. |
| Child list | Quiet label + hanging list or list rows | Sub-lines under a parent. |
| Dependency line | Wiki link + quiet words | This needs that. On the same paper. |
| Confirm pair | Two hairline buttons | Accept and Reject, or any two uses of the same button. |
| Confirm destroy | Dialog/confirm panel + confirm pair | A question before a delete. |
| Settings group | Section head or quiet label + labeled fields | A cluster of settings on paper. |
| Filter chips row | Chip/tag | One or more hairline words that narrow a list. |
| Pagination strip | Text link + progress fraction | Previous, Next, and page n of m. For long tables. Not a new atom. |
| Attachment line | Text link + quiet meta + text link | A vault file name, optional size, and remove. |
| Quiet sheet | Sheet/drawer on the paper, no scrim | A hairline panel on the same paper. Not a second room. |
| Duration mark | Faint tabular body | How long, such as 45 min. Not a timesheet widget. |

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
| Success | Soft notice or saved chip in `--ok`. Not a toast stack. |
| Selected | `--ink` and `--hairline-strong`. Week card and month day already do this. |
| Dragging | Drag preview: faded block, dashed strong hairline. |
| Checked | Checkbox uses `--ok`. |
| Expanded | A sheet, menu, or popover is open. Same hairline. No new chrome. |
| Collapsed | The same control is shut. The trigger word remains. |

A checked box uses `--ok`. Saving uses the saved chip and does not shove the paper.
