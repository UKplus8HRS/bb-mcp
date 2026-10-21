import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { archive } from "./archive-blackboard-file.mjs";

test("keeps original format, reuses identical files, and versions changed files", async () => {
  const temporaryRoot = path.join(os.tmpdir(), "codex-blackboard-downloads");
  await mkdir(temporaryRoot, { recursive: true });
  const downloads = await mkdtemp(path.join(temporaryRoot, "test-"));
  const course = `archive-test-${randomUUID()}`;
  const materials = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "materials");
  const archived = path.join(materials, course);
  assert.equal(path.dirname(archived), materials);
  assert.equal(path.dirname(path.resolve(downloads)), path.resolve(temporaryRoot));
  try {
    const first = path.join(downloads, "first.pdf");
    const second = path.join(downloads, "second.pdf");
    const third = path.join(downloads, "third.pdf");
    await writeFile(first, "original");
    await writeFile(second, "original");
    await writeFile(third, "updated");
    const a = await archive(first, course, "Week 1", "Lecture: 1?.pdf");
    const b = await archive(second, course, "Week 1", "Lecture: 1?.pdf");
    const c = await archive(third, course, "Week 1", "Lecture: 1?.pdf");
    assert.equal(a.status, "saved");
    assert.equal(b.status, "reused");
    assert.equal(b.path, a.path);
    assert.equal(c.status, "saved");
    assert.match(a.path, /Lecture_ 1_\.pdf$/);
    assert.match(c.path, /Lecture_ 1_ \(2\)\.pdf$/);
    assert.equal((await readdir(path.dirname(a.path))).length, 2);
  } finally {
    await rm(downloads, { recursive: true, force: true });
    await rm(archived, { recursive: true, force: true });
  }
});
