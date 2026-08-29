# AidanOS — Christmas cut

AidanOS is a local daily. Markdown in a folder (the vault) is the disk. It binds 127.0.0.1 only.

Two tracks run in parallel. They are not one ship date.

## What ships by Christmas

A stranger can clone, run, and use:

- **Door** — first screen: What do you want to do today?
- **Today** — the day's paper
- **Plan** — the season file (title, why, next steps, waiting)
- **Vault as disk** — plain markdown files, not a database
- **Ask** — find across the vault; a hit opens in the same paper
- **Clay as vault files** — look and feel as files in the vault, smash by deleting; not a theme store

## What does not

- No CRM
- No Tome
- No kernel self-rewrite
- No second store besides the vault (not Salesforce, not a second notes database)
- Not the signed daily-driver vs NotePlan — that is R1, a parallel track, not this cut

## How to tell it is done

A stranger can run it from this repo by Christmas. Door, Today, Plan, Ask, and a vault of files. Clay is files. Nothing listed under What does not is in the tree.

## Run

You need Node 18 or newer. Clone and start:

git clone https://github.com/MotorUnitRoot/aidanos.git && cd aidanos && ./start.sh

Open http://127.0.0.1:3847/. The first screen is Door: What do you want to do today?

It binds 127.0.0.1 only. The vault is the sibling vault/ folder, or wherever AIDANOS_VAULT points.
