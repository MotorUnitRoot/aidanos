// Loaded only by worker.test.mjs. node --test does not pick up this folder.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import { createExclusive, openCheckedDirectory } from "../../../editor/dirfd.mjs";

if (parentPort) {
  const dir = await openCheckedDirectory(workerData.dir);
  try {
    await createExclusive(dir, "from-worker.txt", Buffer.from("from-worker"));
    const link = await fs.readlink("/proc/self/fd/" + dir.fd);
    parentPort.postMessage({ ok: true, link });
  } finally {
    await dir.close();
  }
}
