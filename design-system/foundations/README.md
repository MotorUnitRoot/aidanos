# Foundations

These tokens are the visual language. They live in `tokens.css`, not in a paragraph. A vault `skin.css` may change color and type. It may not change spacing, paper width, or layout.

## Type
One serif for the whole product: Iowan Old Style, then Palatino, then Georgia. Body copy uses this face at the room size. Headings in a note are real markdown headings in the same face. Quiet labels use the same face with `--quiet` ink. There is no second font for chrome.

## Color
Stoic cream on charcoal. Room `--bg` is `#161513`. Surface `--surface` is `#1d1c19`. Ink `--ink` is `#f2eee6`. Quiet ink `--quiet` is `#9a9488`. Fainter `--faint` is `#6d6960`. Hairline `--hairline` is `#2c2a26`. Success is a muted green. Danger is a muted red. Do not introduce brand orange, sport underlines, or a rainbow.

## Spacing
Use the scale in `tokens.css`: a quarter rem, a half rem, one rem, one and a half, two and a half, four. The paper is `--paper` (42rem) and centered. Agenda rows are `--slot` (two rem, a half hour). Hairlines are one pixel. Corners stay square.

## States
Default is cream ink on the room. Hover brightens quiet ink to ink. Focus is a hairline, not a glow. Disabled is `--faint`. A checked box uses `--ok`. An empty day says “Write.” An empty Ask result is quiet, not an error banner. Dragging shows a faded block on the slot you are over. Saving is a reserved chip that does not shove the paper.
