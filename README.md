# AidanOS

AidanOS is a daily notebook that runs on your computer. The disk is a folder of markdown files, called the vault. It listens on this computer only.

## Run

You need Node 18 or newer.

```
git clone https://github.com/MotorUnitRoot/aidanos.git && cd aidanos && ./start.sh
```

Open http://127.0.0.1:3847/. The first screen asks, “What do you want to do today?”

The vault is the `vault/` folder next to the app, or the folder named in `AIDANOS_VAULT`.

## The daily

The first screen is almost empty. Today is the day’s note. Plan is this season’s file: a title, why it matters, what comes next, and what is waiting. Ask finds across the vault. A result opens in the same note, not a preview.

The vault is the only store. There is not a second database, not a CRM, and not a shop of themes. Look and feel can live as a file in the vault. Delete that file and the default returns.

## Process maps

A process map is an ordinary markdown file in the vault. Copying the file is how you take the work. Deleting the file is how you drop it. There is not a catalog of workflows, and there is not a second product behind the map.

This repository ships two maps: reply to a letter, and file a receipt. Ask for that work, or name it at the door, and the next steps land on today’s note as ordinary tasks. You do not have to open the map first.

## Last-mile

When the work needs a place to write the letter or note the receipt, that place is another markdown file next to the map. It opens in the same note as the day. Those files are assembled from the design system already used for AidanOS. They are not a new look and not a CRM screen. Change the file, or delete it.

## What this is not

This is not Salesforce. It is not a second notes app. It is not the Tome. The phone can stay NotePlan, pulling into the same vault.
