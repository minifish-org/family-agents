import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "./store.js";
import type { ImageGenerationItem } from "./generated/codex/ImageGenerationItem.js";
import type { RuntimeImage } from "./runtime.js";

export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
const failure = () => new AppError(400, "The generated image could not be delivered safely.");
const segment = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_") || "generated_image";

/** Reads only the native extension's exact artifact for this thread and item. */
function artifact(home: string, threadId: string, item: ImageGenerationItem): Buffer {
  if (typeof item.savedPath !== "string") throw failure();
  const extension = item.savedPath.endsWith(".gif") ? "gif" : "png";
  const root = resolve(home), generated = join(root, "generated_images"), thread = join(generated, segment(threadId));
  const expected = join(thread, `${segment(item.id)}.${extension}`);
  if (resolve(item.savedPath) !== expected) throw failure();
  const homeStat = lstatSync(root);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (homeStat.mode & 0o077)) throw failure();
  if (process.getuid && homeStat.uid !== process.getuid()) throw failure();
  for (const directory of [generated, thread]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
  }
  const before = lstatSync(expected);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !before.size || before.size > MAX_GENERATED_IMAGE_BYTES) throw failure();
  const canonical = join(realpathSync(root), "generated_images", segment(threadId), `${segment(item.id)}.${extension}`);
  if (realpathSync(expected) !== canonical) throw failure();
  const fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || realpathSync(expected) !== canonical) throw failure();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== before.size || fstatSync(fd).size !== before.size) throw failure();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

/** Native notifications are trusted transport, but their bytes and path still need bounds. */
export function generatedImage(home: string, threadId: string, item: ImageGenerationItem): RuntimeImage {
  let bytes: Buffer;
  try {
    if ("result" in item && typeof item.result === "string" && item.result.trim()) {
      const encoded = item.result.trim();
      if (encoded.length > 4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3)
        || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw failure();
      bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw failure();
    } else bytes = artifact(home, threadId, item);
  } catch { throw failure(); }
  if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES) throw failure();
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
    : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined;
  if (!mimeType) throw failure();
  return { data: bytes.toString("base64"), mimeType, name: `generated-image.${mimeType === "image/jpeg" ? "jpg" : mimeType.slice(6)}` };
}
