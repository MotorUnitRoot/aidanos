# How to keep building AidanOS

DESIGN.md is the law. This page is the design system. It lives beside that law, in the vault, not in Figma and not in a catalog of themes. Architect ships from these rules. A screen that needs a new look still uses this type, this color, this paper, and this layout.

## Type
One serif for the whole product: Iowan Old Style, then Palatino, then Georgia. Chrome does not get a second font. Headings in a note are real markdown headings. Quiet labels use the same face in quieter ink.

## Color
The default skin is Stoic, cream on charcoal. The room is `#161513`. A surface is `#1d1c19`. Ink is `#f2eee6`. Quiet ink is `#9a9488`. Fainter ink is `#6d6960`. A hairline is `#2c2a26`.

A person may keep one `skin.css` in their vault. That file may change color and type. It may not add chrome, extra panels, or a new layout. There is no shop of skins.

## Paper
The writing column is 42rem wide and centered. What is saved is ordinary markdown. On screen the note should read as finished copy: hanging lists, checkboxes you can tick, air between blocks. History may scroll; it should not become a wall of raw marks.

## Door
The first screen is almost empty. The question is a prompt bar: “What do you want to do today?” Get to Work opens the day with nothing typed. Capture thoughts opens a blank page for writing. Empty Enter still opens the day. There is no conversation thread and no menu of other places to go.

## Today
Week cards sit at the top of the left column. Opening a card opens that day’s note, and anything entered for that day. The paper sits under the cards.

The right side is one day. A month grid may sit above a Google-style agenda in half-hour slots. Dragging a line from the note onto a slot places it in time. The slot shows a preview while you drag, and a block can be stretched to the duration it needs. The month can be shown or hidden.

At the bottom is Ask or find. A result has a file name and opens in the same paper. Ask is not a dumb search box. When someone asks for the work, it should put the next steps on today rather than only listing files.

## Plan
The plan is this season’s file: a title, why it matters, what comes next, and what is waiting. It uses the same paper as the day. It is not a second product.

## Last-mile screens
Door, Today, and Plan are the product. When a task needs another screen, that screen is made as files in the vault next to the work. A person can open those files, change them, and delete them. They are not frames in Figma, not a component library, and not a settings page. You ask, and the app writes the files.

## Disk
The vault is the disk. Folders are projects. Wiki links connect notes. PARA may describe the folders; it is not a second database. If a graph view exists, it is a view of those files.
