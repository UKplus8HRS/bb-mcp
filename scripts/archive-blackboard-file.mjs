import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, lstat, mkdir, realpath, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.join(os.tmpdir(), "codex-blackboard-downloads");

function safeName(value) {
  const name = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "_");
  if (!name || name === "." || name === "..") throw new Error("A non-empty name is required.");
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

async function directory(parent, name) {
  const target = path.join(parent, name);
  try { await mkdir(target); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Archive directory is not a regular directory.");
  return target;
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function archive(source, course, section, filename) {
  const realSource = await realpath(source);
  const realTemporaryRoot = await realpath(temporaryRoot);
  const relativeSource = path.relative(realTemporaryRoot, realSource);
  if (!relativeSource || relativeSource === ".." || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
    throw new Error("Source must be a downloaded file in the Blackboard temporary directory.");
  }
  if (!(await stat(realSource)).isFile()) throw new Error("Source is not a regular file.");

  const root = await directory(projectRoot, "materials");
  const courseDir = await directory(root, safeName(course));
  const sectionDir = await directory(courseDir, safeName(section || "general"));
  const original = safeName(filename);
  const sourceHash = await digest(realSource);
  const sourceSize = (await stat(realSource)).size;
  const { name, ext } = path.parse(original);
  for (let number = 1; ; number++) {
    const destination = path.join(sectionDir, number === 1 ? original : `${name} (${number})${ext}`);
    try {
      await copyFile(realSource, destination, constants.COPYFILE_EXCL);
      await unlink(realSource);
      return { path: destination, status: "saved" };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const existing = await lstat(destination);
    if (existing.isFile() && existing.size === sourceSize && await digest(destination) === sourceHash) {
      await unlink(realSource);
      return { path: destination, status: "reused" };
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, course, section, filename] = process.argv.slice(2);
  if (!source || !course || !filename) {
    console.error("Usage: node archive-blackboard-file.mjs <temporary-path> <course> <section-or-topic> <download-suggested-filename>");
    process.exitCode = 2;
  } else {
    archive(source, course, section, filename).then(result => console.log(JSON.stringify(result)), error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
