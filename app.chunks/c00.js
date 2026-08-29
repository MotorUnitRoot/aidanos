const $ = (id) => document.getElementById(id);

const state = {
  weekStart: null,
  week: null,
  day: null,
  doc: null,
  selectedDate: null,
  saveTimer: null,
  dirty: false,
  monthShown: false,
  monthView: null,
  paintTimer: null,
  askTimer: null,
  askGen: 0,
  openDayGen: 0,
  lastPaperSelection: "",
  activeLine: -1,
  folderDir: "",
  plan: { title: "", why: "", steps: [], parked: [] },
};

const PAGE_VIEWS = ["door", "today", "plan"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_FULL = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
function daySlots() {
  const times = [];
  for (let h = 6; h <= 21; h++) {
    const hh = String(h).padStart(2, "0");
    times.push(hh + ":00");
    times.push(hh + ":30");
  }
  times.push("22:00");
  return times;
}
const WHEN_RE = /@(?:\d{4}-\d{2}-\d{2}[ T])?(\d{1,2}:\d{2})\b/;

function mondayOf(d = new Date()) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return iso(x);
}

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function todayIso() { return iso(new Date()); }

function addDays(isoStr, n) {
  const x = new Date(isoStr + "T12:00:00");
  x.setDate(x.getDate() + n);
  return iso(x);
}

function parseDate(dateStr) {
  return new Date(dateStr + "T12:00:00");
}

function formatPaperTitle(dateStr) {
  return parseDate(dateStr).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatRailDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatCardMonth(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() +
    " " + d.getFullYear();
}

function energyLabel(d) {
  const role = String(d.role || "").trim();
  if (/^(train|flex|rest)$/i.test(role)) {
    return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
  }
  if (role && !/father|builder|writer/i.test(role)) return role;
  const e = String(d.energy || "").toLowerCase();
  if (e === "flex") return "Flex";
  if (e === "rest") return "Rest";
  return "Train";
}
