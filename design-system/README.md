# AidanOS design system

DESIGN.md is the law. SYSTEM.md is a short note. This folder is the design system: foundations, a component library, an atomic library, and patterns.

This is the contract last-mile generation obeys, not a shop style guide. AidanOS will generate applications from whole cloth. Those screens always follow this system. A generated screen can only be assembled from these tokens, these parts, and these patterns. If a last-mile file would need a new look, the system is wrong. Generation does not invent a widget, a color, a typeface, or a second store to get unstuck. The system changes first, or the screen is not shipped.

Open `components/library.html` and `patterns/` in a browser to see the Door, Today, and Plan parts. Tokens live in `foundations/tokens.css`. The look of each kernel part lives in `components/primitives.css`. Patterns load that file. They do not invent a look.

The atomic library is the closed set of last-mile atoms: foundations, controls, composition patterns, and states. Open `atomic-library/README.md`, `atomic-library/TABLE.md`, and `atomic-library/gallery.html`. Keep is thirty-four atoms. `atomic-library/PRESSURE.md` marks thirteen ordinary surfaces; all pass without a new Keep atom. A generator may assemble any third-level screen only from that closed set plus the kernel already named in `components/`. It may not invent a control mid-flight.

A closed draft once framed CRM, ERP, and project screen jobs as a table. That pull request (number 7) was snipped. This library is atoms, not jobs. Do not revive that framing.

The laws that bind this system: the Door stays almost empty; the paper is 42rem and quiet like Byword, with NotePlan muscle; the skin is Stoic; there is no theme catalog, no Salesforce chrome, and no second store. The vault is the disk.
