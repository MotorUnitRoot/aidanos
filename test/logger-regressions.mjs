export function assertLoggerConfidentiality(assert, log, lines) {
  const sentinels = ["LOGGER_DIRECT_CAUSE_ONLY", "LOGGER_DEEP_CAUSE_ONLY", "LOGGER_AGGREGATE_ONLY", "LOGGER_OUTER_ONLY", "LOGGER_STACK_ONLY"];
  const direct = new Error(sentinels[3], { cause: sentinels[0] });
  const nested = new Error(sentinels[3], { cause: new Error("middle", { cause: new Error(sentinels[1]) }) });
  const aggregate = new AggregateError([new Error(sentinels[2]), nested], sentinels[3], { cause: direct });
  let inspected = 0;
  const trapped = new Error("error");
  for (const field of ["stack", "cause", "errors"]) Object.defineProperty(trapped, field, { get() { inspected += 1; throw new Error("private getter must never run"); } });
  const noCoercion = { toString() { inspected += 1; throw new Error("private coercion must never run"); } };
  for (const error of [direct, nested, aggregate, trapped, noCoercion]) {
    log("error", error);
  }
  const stacked = new Error(sentinels[3]); stacked.stack = sentinels[4]; log("error", stacked);
  for (const sentinel of sentinels) log(sentinel);
  const good = Object.assign(new Error(sentinels[3], { cause: aggregate }), { code: "EACCES" });
  log("error", good);
  assert(lines.at(-1).includes("code=EACCES"), "exact public errno disappeared from logger");
  for (const code of ["EACCES_extra", "EACCES\n" + sentinels[0], noCoercion, 5]) log("error", { code, message: sentinels[3], cause: aggregate });
  const codeGetter = Object.defineProperty({}, "code", { get() { inspected += 1; throw new Error("code getter must not run"); } });
  log("error", codeGetter);
  assert(inspected === 0, "logger inspected a stack/cause/errors/getter or coerced an object");
  for (const sentinel of sentinels) assert(!lines.join("\n").includes(sentinel), "error/cause/aggregate contents reached log output");
  assert(lines.every((line) => typeof line === "string" && !/[\r\n]/.test(line)), "logger emitted an object or injected diagnostic line");
  assert(lines.length === 17, "logger regression must actually capture every call");
}
