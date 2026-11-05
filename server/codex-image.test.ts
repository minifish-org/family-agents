import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedImage, MAX_GENERATED_IMAGE_BYTES } from "./codex-image.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = (values: object = {}) => ({ id: "image-call", status: "completed", result: png, revisedPrompt: null, generationId: null, failure: null, ...values });

test("generated images accept bounded image bytes and reject malformed or non-image base64", () => {
  assert.deepEqual(generatedImage("/unused", "thread", image()), { data: png, mimeType: "image/png", name: "generated-image.png" });
  for (const result of ["not base64!", Buffer.from("private text").toString("base64"), "", "A".repeat(4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) + 4)])
    assert.throws(() => generatedImage("/unused", "thread", image({ result })), /could not be delivered safely/);
});

test("saved generated images require the exact private thread artifact and reject other files or links", () => {
  const home = mkdtempSync(join(tmpdir(), "family-generated-image-"));
  chmodSync(home, 0o700);
  const directory = join(home, "generated_images", "thread"), savedPath = join(directory, "image-call.png");
  mkdirSync(directory, { recursive: true });
  writeFileSync(savedPath, png, "base64");
  const saved = (path = savedPath) => image({ result: "", fileId: "file-id", savedPath: path });
  try {
    assert.equal(generatedImage(home, "thread", saved()).data, png);
    assert.throws(() => generatedImage(home, "another-thread", saved()), /could not be delivered safely/);
    const outside = join(home, "private.png");
    writeFileSync(outside, png, "base64");
    assert.throws(() => generatedImage(home, "thread", saved(outside)), /could not be delivered safely/);
    rmSync(savedPath);
    symlinkSync(outside, savedPath);
    assert.throws(() => generatedImage(home, "thread", saved()), /could not be delivered safely/);
    rmSync(savedPath);
    linkSync(outside, savedPath);
    assert.throws(() => generatedImage(home, "thread", saved()), /could not be delivered safely/);
    rmSync(savedPath);
    writeFileSync(savedPath, png, "base64");
    chmodSync(home, 0o750);
    assert.throws(() => generatedImage(home, "thread", saved()), /could not be delivered safely/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a symlinked generated-image directory cannot redirect artifact reads", () => {
  const home = mkdtempSync(join(tmpdir(), "family-generated-image-link-"));
  chmodSync(home, 0o700);
  const outside = join(home, "private"), generated = join(home, "generated_images");
  mkdirSync(join(outside, "thread"), { recursive: true });
  writeFileSync(join(outside, "thread", "image-call.png"), png, "base64");
  symlinkSync(outside, generated);
  try {
    assert.throws(() => generatedImage(home, "thread", image({ result: "", savedPath: join(generated, "thread", "image-call.png") })), /could not be delivered safely/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
