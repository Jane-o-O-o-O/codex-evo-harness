import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const writes = new Map();

// Windows cannot reliably replace the same destination in concurrent renames.
// Serialize only writes to that file; independent files can still write in parallel.
export function writeJsonAtomic(file, value) {
  file = path.resolve(file);
  const key = process.platform === "win32" ? file.toLowerCase() : file;
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const previous = writes.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, source, "utf8");
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }).finally(() => {
    if (writes.get(key) === pending) writes.delete(key);
  });
  writes.set(key, pending);
  return pending;
}
