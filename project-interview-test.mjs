#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function grab(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const next = src.indexOf("\nfunction " + nextName + "(", start + 1);
  if (next < 0) throw new Error("missing next " + nextName);
  return src.slice(start, next);
}

const sandbox = {};
new Function(
  "sandbox",
  grab("projectTitle", "hideDoorProposals") +
    grab("stripAccidentalBulletSpace", "normalizeSeasonPlanMarkdown") +
    grab("isWorkMapPath", "isMapDoc") +
    grab("mapNextStepLines", "taskLineKey") +
    "\nsandbox.projectTitle = projectTitle;" +
    " sandbox.projectSlug = projectSlug;" +
    " sandbox.interviewExperienceMarkdown = interviewExperienceMarkdown;" +
    " sandbox.interviewMaterialsMarkdown = interviewMaterialsMarkdown;" +
    " sandbox.advanceInterview = advanceInterview;" +
    " sandbox.materialsPreference = materialsPreference;" +
    " sandbox.workspaceFiles = workspaceFiles;" +
    " sandbox.stableStepPaths = stableStepPaths;" +
    " sandbox.crystallizePath = crystallizePath;" +
    " sandbox.crystallizeMarkdown = crystallizeMarkdown;" +
    " sandbox.isWorkMapPath = isWorkMapPath;" +
    " sandbox.isStepPath = isStepPath;" +
    " sandbox.mapNextStepLines = mapNextStepLines;" +
    " sandbox.cleanPaperMarkdown = cleanPaperMarkdown;"
)(sandbox);

const {
  projectSlug,
  interviewExperienceMarkdown,
  advanceInterview,
  materialsPreference,
  workspaceFiles,
  stableStepPaths,
  crystallizePath,
  crystallizeMarkdown,
  isWorkMapPath,
  isStepPath,
  mapNextStepLines,
  cleanPaperMarkdown,
} = sandbox;

const results = [];
function check(name, run) {
  try {
    const out = run();
    if (out && typeof out.then === "function") {
      return out.then(() => {
        results.push({ name, ok: true });
        console.log("pass  " + name);
      }).catch((err) => {
        results.push({ name, ok: false, error: err.message });
        console.log("FAIL  " + name + "  " + err.message);
      });
    }
    results.push({ name, ok: true });
    console.log("pass  " + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log("FAIL  " + name + "  " + err.message);
  }
}

const INTENT = "Remodel my basement to have an office";
const EXPERIENCE = "I gophered for a GC for a summer. I can swing a hammer.";

check("unknown work starts an interview, not a split task list", () => {
  const md = interviewExperienceMarkdown(INTENT);
  assert(md.includes("interview: experience"), "phase");
  assert(md.includes("I don't think we've done this together."), "vault has no map for this");
  assert(md.includes("## Experience"), "experience question");
  assert(!md.includes("- [ ] Remodel"), "does not invent a task from the sentence");
  assert(projectSlug(INTENT) === "remodel-basement-office", "slug from the work, not the stop words");
  const cleaned = cleanPaperMarkdown(md);
  assert(cleaned.includes("interview: experience\n---"), "the phase fence stays a fence");
});

check("experience then materials, then a workspace", () => {
  let md = interviewExperienceMarkdown(INTENT);
  md = md.replace("- [ ] This is the answer", EXPERIENCE + "\n\n- [x] This is the answer");
  const stepped = advanceInterview(md);
  assert(stepped && stepped.markdown && !stepped.build, "first answer asks the next question");
  assert(stepped.markdown.includes("interview: materials"), "materials phase");
  assert(stepped.markdown.includes(EXPERIENCE), "keeps the experience");
  assert(stepped.markdown.includes("Videos, written materials, or both?"), "second question");
  let materials = stepped.markdown.replace(
    /- \[ \] This is the answer/,
    "Both, please.\n\n- [x] This is the answer"
  );
  const built = advanceInterview(materials);
  assert(built && built.build, "both answers build");
  assert(built.experience === EXPERIENCE, "experience is the user's words");
  assert(materialsPreference(built.materials) === "both", "both");
  const files = workspaceFiles(built);
  assert(!files.some((f) => /repeat-/.test(f.path)), "first workspace does not crystallize");
  const plan = files.find((f) => f.path === "projects/remodel-basement-office/plan.md");
  const map = files.find((f) => f.path === "maps/remodel-basement-office.md");
  const step = files.find((f) => f.path === "maps/the-remodel-basement-office-see-the-place.md");
  assert(plan && map && step, "plan, map, and a step note");
  assert(plan.markdown.includes("## Why"), "plan why");
  assert(plan.markdown.includes("## Experience"), "plan experience");
  assert(plan.markdown.includes(EXPERIENCE), "experience stored on the plan");
  assert(plan.markdown.includes("## Next steps"), "plan next");
  assert(plan.markdown.includes("## Waiting"), "plan waiting");
  assert(!plan.markdown.includes("interview:"), "interview is over");
  assert(isWorkMapPath(map.path), "map is a work map");
  assert(!isWorkMapPath(step.path) && isStepPath(step.path), "step note is last-mile, not a second map");
  assert(map.markdown.includes("Enter:"), "stage enter");
  assert(map.markdown.includes("Exit:"), "stage exit");
  const today = mapNextStepLines(map.markdown);
  assert(today.length === 4, "four tasks for today");
  assert(today.every((line) => line.includes("[[remodel-basement-office]]")), "today tasks wiki-link the map");
  assert(step.markdown.includes("You said:"), "written article");
  assert(step.markdown.includes("youtube.com"), "video link");
  assert(step.markdown.includes("[See more materials]("), "see more is a link");
  assert(step.markdown.includes("Ask about this step"), "ask about this step");
  assert(step.markdown.includes("[[remodel-basement-office]]"), "step points at the map");
});

check("materials choice changes the step note", () => {
  const video = workspaceFiles({ title: INTENT, experience: EXPERIENCE, materials: "Just videos" });
  const written = workspaceFiles({ title: INTENT, experience: EXPERIENCE, materials: "Written notes please" });
  const v = video.find((f) => /see-the-place/.test(f.path)).markdown;
  const w = written.find((f) => /see-the-place/.test(f.path)).markdown;
  assert(v.includes("youtube.com") && !v.includes("You said:"), "video keeps the film and skips the article");
  assert(!w.includes("youtube.com") && w.includes("You said:"), "written keeps the article and skips the film");
  assert(v.includes("[See more materials](") && w.includes("[See more materials]("), "see more stays");
  assert(materialsPreference("videos and articles") === "both", "both words");
});

check("a short tick does not advance", () => {
  let md = interviewExperienceMarkdown(INTENT);
  md = md.replace("- [ ] This is the answer", "- [x] This is the answer");
  const next = advanceInterview(md);
  assert(next && next.markdown && !next.build, "unticks");
  assert(next.markdown.includes("- [ ] This is the answer"), "gate is open again");
  assert(!next.markdown.includes("interview: materials"), "still on experience");
});

check("crystallize only after the same step is done twice", () => {
  const key = "see the place";
  const one = stableStepPaths(key, [
    { path: "maps/remodel-basement-office.md", text: "- [x] See the place [[remodel-basement-office]]" },
  ]);
  assert(one.length === 1, "one file is not stable");
  const two = stableStepPaths(key, [
    { path: "maps/remodel-basement-office.md", text: "- [x] See the place" },
    { path: "log/2026-10-06.md", text: "- [x] See the place" },
    { path: "log/2026-10-06.md", text: "- [x] See the place" },
  ]);
  assert(two.length === 2, "two files, not two lines");
  const open = stableStepPaths(key, [
    { path: "maps/remodel-basement-office.md", text: "- [ ] See the place" },
    { path: "log/2026-10-06.md", text: "- [x] See the place" },
  ]);
  assert(open.length === 1, "an open box does not count");
  const file = crystallizeMarkdown("See the place");
  assert(file.includes("# See the place"), "title");
  assert(file.includes("done twice"), "says why it exists");
  assert(file.includes("- [ ] See the place"), "the check is the work");
  assert(!file.includes("interview:"), "no interview");
  assert(!file.includes("youtube.com"), "no new article");
  assert(crystallizePath("remodel-basement-office", "See the place") === "projects/remodel-basement-office/repeat-see-the-place.md", "path beside the project");
  assert(stableStepPaths("this is the answer", [
    { path: "a.md", text: "- [x] This is the answer" },
    { path: "b.md", text: "- [x] This is the answer" },
  ]).length === 0, "the interview gate is not a pattern");
});

check("Door stays one question", () => {
  const submit = src.slice(src.indexOf('$("door-form").addEventListener("submit"'), src.indexOf("async function openPlanNote("));
  assert(submit.includes("landDoorQueryOnToday"), "known map still lands");
  assert(submit.includes("openProjectInterview("), "unknown work leaves the Door");
  assert(!submit.includes("proposeDoorLines"), "no sentence split on the Door");
  assert(!/conversation/i.test(submit), "no thread on the Door");
  const skip = src.slice(src.indexOf('$("door-skip").addEventListener("click"'), src.indexOf("(function wireDoorCapture()"));
  assert(skip.includes("goToday()"), "Get to Work opens today");
  assert(!skip.includes("openProjectInterview"), "Get to Work invents nothing");
});

const pending = [];
check("workspace files round-trip through the vault", () => {
  const files = workspaceFiles({
    title: INTENT,
    experience: EXPERIENCE,
    materials: "Both, please.",
  });
  pending.push((async () => {
    const __dirname = root;
    const PORT = 19000 + Math.floor(Math.random() * 2000);
    const origin = `http://127.0.0.1:${PORT}`;
    const vault = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aidanos-project-"));
    await fs.promises.mkdir(path.join(vault, "log"), { recursive: true });
    const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(PORT),
        AIDANOS_HOST: "127.0.0.1",
        AIDANOS_VAULT: vault,
        AIDANOS_VAULT_GIT_URL: "",
        AIDANOS_VAULT_GIT_TOKEN: "",
        GITHUB_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
    async function cleanup() {
      try { child.kill("SIGTERM"); } catch {}
      await sleep(80);
      try { child.kill("SIGKILL"); } catch {}
      try { await fs.promises.rm(vault, { recursive: true, force: true }); } catch {}
    }
    try {
      const t0 = Date.now();
      let up = false;
      while (Date.now() - t0 < 8000) {
        try {
          const r = await fetch(origin + "/api/health");
          if (r.ok) { up = true; break; }
        } catch {}
        await sleep(40);
      }
      assert(up, "server up");
      for (const file of files) {
        const put = await fetch(origin + "/api/file?path=" + encodeURIComponent(file.path), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ markdown: file.markdown, mtime: 0 }),
        });
        assert(put.ok, "PUT " + file.path + " " + put.status);
      }
      const got = await (await fetch(origin + "/api/file?path=" + encodeURIComponent("projects/remodel-basement-office/plan.md"))).json();
      assert(got.markdown.includes(EXPERIENCE), "plan on disk");
      const step = await (await fetch(origin + "/api/file?path=" + encodeURIComponent("maps/the-remodel-basement-office-learn-the-skill.md"))).json();
      assert(step.markdown.includes("Ask about this step"), "step note on disk");
      const repeat = await fetch(origin + "/api/file?path=" + encodeURIComponent("projects/remodel-basement-office/repeat-see-the-place.md"));
      assert(repeat.status === 404, "no crystallized file on first write");
    } finally {
      await cleanup();
    }
  })());
});

const failed = [];
Promise.all(pending.concat(results.filter((r) => r && r.then).map(() => null)).filter(Boolean)).then(() => {
  // pending is the only async; sync checks already recorded
}).catch(() => {});

await Promise.all(pending);
const bad = results.filter((r) => !r.ok);
if (bad.length) {
  console.log("");
  console.log(bad.length + " failed, " + (results.length - bad.length) + " passed");
  process.exit(1);
}
console.log("");
console.log("project-interview-test ok  (" + results.length + " passed)");
