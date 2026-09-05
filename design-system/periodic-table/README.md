# Periodic table of UX elements

This folder expands the design system beyond Door, Today, Plan, and today’s last-mile screens. Those already have a closed library in `../components/`. AidanOS will also generate applications for third-level work. Those generated screens must still obey DESIGN.md and the Stoic tokens in `../foundations/`. They may only assemble elements from this table and from the existing library.

This is not a Figma file. It is not a catalog of themes. It is not Salesforce chrome. Each element names a job. Where CRM, ERP, or project tools show that job behind heavy chrome, AidanOS keeps the job and drops the costume.

## How to read the table

`TABLE.md` is the closed list. Elements are grouped by family, like groups in a periodic table. Each entry has:

- What it is
- Where it shows up in CRM, ERP, and project tools
- How AidanOS uses it (Stoic paper, one serif, no second store)
- Whether it is already in the Door/Today/Plan library, newly named here, deferred, or refused

Generation may use only Keep and Already. Deferred waits for a later mark. Refused never ships.

## Method

The forensic pass looked at record pages and related lists in CRM (Salesforce Lightning and similar), forms and sublists in ERP (NetSuite-style master and detail), and issue and list views in project tools (Jira, Linear, Asana-style). The question was always the job: what must a tired person see, change, or connect? Chrome that only brands the vendor was refused. Patterns that force a second database or a theme shop were refused.

## Relation to the existing library

Door prompt bar, hairline button, text link, week card, week and day chevrons, 42rem paper, checkbox, hanging list, wiki link, quiet label, empty state, Ask strip, search hit, half-hour agenda slot, drag preview, month day, and saved chip stay as named. This table does not replace them. It adds the missing jobs for generated work and names what must never be invented.
