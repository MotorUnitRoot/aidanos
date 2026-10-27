// Shared note editor for the Mac and iPhone screens.
//
// The text he types is the file. Nothing here rewrites a line except a tick
// he asked for. Line shapes for the native apps come from the line reader in
// the shared core. This module paints plain markdown the paper already uses:
// a heading mark, a hanging list, and a task box.

export function keepTyped(markdown) {
  return String(markdown ?? "");
}

export function makeHeading(line) {
  const text = String(line ?? "");
  if (/^\s*#{1,6}\s/.test(text)) return text;
  return text.replace(/^(\s*)/, "$1# ");
}

export function makeList(line) {
  const text = String(line ?? "");
  if (/^\s*[-*+]\s+\[/.test(text)) return text;
  if (/^\s*([-*+]|\d+[.)])\s/.test(text)) return text;
  return text.replace(/^(\s*)/, "$1- ");
}

export function indentLine(line) {
  return "  " + String(line ?? "");
}

export function outdentLine(line) {
  const text = String(line ?? "");
  if (text.startsWith("\t")) return text.slice(1);
  if (text.startsWith("  ")) return text.slice(2);
  return text;
}

// A tick changes the box on that line and leaves the words after it.
export function tickLine(line) {
  const text = String(line ?? "");
  const task = text.match(/^(\s*[-*+]\s+)\[([ xX]?)\](.*)$/);
  if (!task) return text;
  const mark = task[2];
  if (mark !== "" && mark !== " " && mark.toLowerCase() !== "x") return text;
  const box = mark.toLowerCase() === "x" ? "[ ]" : "[x]";
  return task[1] + box + task[3];
}

export function shapeLine(line) {
  const text = String(line ?? "");
  if (text === "") return { role: "empty", source: text };
  let match = text.match(/^(#{1,6}) (.*)$/);
  if (match) return { role: "heading", level: match[1].length, source: text };
  match = text.match(/^(\s*)([-*+])\s+\[([ xX\->]?)\](.*)$/);
  if (match) {
    if (match[3] === "-") return { role: "cancelled", source: text };
    if (match[3] === ">") return { role: "scheduled", source: text };
    return {
      role: "task",
      ticked: match[3].toLowerCase() === "x",
      indent: match[1].replace(/\t/g, "  ").length,
      source: text,
    };
  }
  match = text.match(/^(\s*)([-*+])\s+(.*)$/);
  if (match) {
    return { role: "list", indent: match[1].replace(/\t/g, "  ").length, source: text };
  }
  match = text.match(/^(\s*)(\d+[.)])\s+(.*)$/);
  if (match) {
    return { role: "list", indent: match[1].replace(/\t/g, "  ").length, source: text };
  }
  match = text.match(/^(\s{2,}|\t+)(\S.*)$/);
  if (match) {
    return { role: "plain", indent: match[1].replace(/\t/g, "  ").length, source: text };
  }
  return { role: "plain", source: text };
}

export function shapeNote(text) {
  const source = String(text ?? "");
  if (source === "") return [];
  return source.split("\n").map(shapeLine);
}

export function createLiveNote(initial = "") {
  let text = keepTyped(initial);
  const undoStack = [];
  const redoStack = [];
  const cap = 200;

  function commit(next) {
    const value = keepTyped(next);
    if (value === text) return text;
    undoStack.push(text);
    if (undoStack.length > cap) undoStack.shift();
    redoStack.length = 0;
    text = value;
    return text;
  }

  return {
    text() {
      return text;
    },
    shapes() {
      return shapeNote(text);
    },
    shapeLineAt(index) {
      const lines = text.split("\n");
      if (index < 0 || index >= lines.length) return null;
      return shapeLine(lines[index]);
    },
    type(next) {
      return commit(next);
    },
    replace(start, end, insert) {
      const source = text;
      const from = Math.max(0, Math.min(source.length, start));
      const to = Math.max(from, Math.min(source.length, end));
      return commit(source.slice(0, from) + String(insert ?? "") + source.slice(to));
    },
    tick(index) {
      const lines = text.split("\n");
      if (index < 0 || index >= lines.length) return text;
      const next = tickLine(lines[index]);
      if (next === lines[index]) return text;
      lines[index] = next;
      return commit(lines.join("\n"));
    },
    undo() {
      if (!undoStack.length) return null;
      redoStack.push(text);
      text = undoStack.pop();
      return text;
    },
    redo() {
      if (!redoStack.length) return null;
      undoStack.push(text);
      text = redoStack.pop();
      return text;
    },
  };
}

export const AidanLiveNote = {
  keepTyped,
  makeHeading,
  makeList,
  indentLine,
  outdentLine,
  tickLine,
  shapeLine,
  shapeNote,
  createLiveNote,
};

globalThis.AidanLiveNote = AidanLiveNote;
