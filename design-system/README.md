# AidanOS design system

DESIGN.md is the law. SYSTEM.md is a short note. This folder is the design system: foundations, a component library, and patterns.

This is the contract last-mile generation obeys, not a shop style guide. AidanOS will generate applications from whole cloth. Those screens always follow this system. A generated screen can only be assembled from these tokens, these parts, and these patterns. If a last-mile file would need a new look, the system is wrong. Generation does not invent a widget, a color, a typeface, or a second store to get unstuck. The system changes first, or the screen is not shipped.

Open `components/library.html` and `patterns/` in a browser to see the parts. Tokens live in `foundations/tokens.css`. The look of each part lives in `components/primitives.css`. Patterns load that file. They do not invent a look.

The laws that bind this system: the Door stays almost empty; the paper is 42rem and quiet like Byword, with NotePlan muscle; the skin is Stoic; there is no theme catalog, no Salesforce chrome, and no second store.

## Periodic table

Generated work that is not Door, Today, or Plan still obeys this system. The closed list of extra jobs lives in `periodic-table/`. Open `periodic-table/TABLE.md` and `periodic-table/gallery.html` to mark it.
