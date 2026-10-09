#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const start = src.indexOf("(function wireRailToggle()");
assert(start >= 0, "wireRailToggle missing");
const end = src.indexOf("\n})();", start);
assert(end > start, "wireRailToggle unclosed");
const iife = src.slice(start, end + "\n})();".length);
assert(iife.includes('matchMedia("(max-width: 720px)")'), "rail watches 720px");
assert(iife.includes('addEventListener("change"'), "rail listens for the width crossing");

function boot(matches) {
  const listeners = [];
  const mq = {
    matches,
    media: "(max-width: 720px)",
    addEventListener(type, fn) {
      assert(type === "change", "listener is for change");
      listeners.push(fn);
    },
  };
  const room = {
    collapsed: false,
    classList: {
      toggle(name, on) {
        assert(name === "rail-collapsed", "only the rail class is toggled");
        room.collapsed = !!on;
      },
      contains(name) {
        return name === "rail-collapsed" && room.collapsed;
      },
    },
  };
  const btn = {
    textContent: "Timeline",
    attrs: { "aria-expanded": "false" },
    onclick: null,
    setAttribute(name, value) { btn.attrs[name] = value; },
    addEventListener(type, fn) {
      assert(type === "click", "button listener is click");
      btn.onclick = fn;
    },
  };
  const document = {
    getElementById(id) { return id === "toggle-rail" ? btn : null; },
    querySelector(sel) { return sel === ".today-room" ? room : null; },
  };
  const window = {
    matchMedia(query) {
      assert(query === "(max-width: 720px)", "query is max-width 720px");
      return mq;
    },
  };
  const context = vm.createContext({ window, document });
  vm.runInContext("const $ = (id) => document.getElementById(id);\n" + iife, context);
  return {
    collapsed: () => room.collapsed,
    text: () => btn.textContent,
    expanded: () => btn.attrs["aria-expanded"],
    click() { btn.onclick(); },
    cross(next) {
      mq.matches = next;
      assert(listeners.length === 1, "one width listener");
      listeners[0]({ matches: next, media: mq.media });
    },
  };
}

const wide = boot(false);
assert(!wide.collapsed(), "a wide load leaves the rail open");
assert(wide.text() === "Timeline", "a wide load does not relabel the button");
wide.cross(true);
assert(wide.collapsed(), "crossing to 720px or narrower folds the rail");
assert(wide.text() === "Timeline" && wide.expanded() === "false", "folded rail offers Timeline");
wide.cross(false);
assert(!wide.collapsed(), "crossing wider than 720px unfolds the rail");
assert(wide.text() === "Hide timeline" && wide.expanded() === "true", "open rail offers Hide timeline");

const narrow = boot(true);
assert(narrow.collapsed(), "a narrow load still folds the rail");
assert(narrow.text() === "Timeline" && narrow.expanded() === "false", "narrow load uses the folded label");
narrow.cross(false);
assert(!narrow.collapsed(), "crossing from a narrow load to wide unfolds the rail");
narrow.cross(true);
assert(narrow.collapsed(), "crossing back to 720px or narrower folds the rail again");

const opened = boot(false);
opened.cross(true);
opened.click();
assert(!opened.collapsed(), "a hand open shows the rail");
opened.cross(false);
assert(!opened.collapsed(), "a hand open stays open when the window gets wider");
opened.cross(true);
assert(opened.collapsed(), "crossing into the narrow layout folds a rail that was opened by hand");
opened.cross(false);
assert(!opened.collapsed(), "the hand open returns when the window is wide again");

const closed = boot(true);
closed.click();
closed.click();
assert(closed.collapsed(), "a second hand click closes the rail");
closed.cross(false);
assert(closed.collapsed(), "a hand close stays closed when the window gets wider");
closed.cross(true);
assert(closed.collapsed(), "the narrow layout keeps a hand-closed rail folded");

console.log("rail-fold-test ok");
