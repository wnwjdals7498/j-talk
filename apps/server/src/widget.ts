import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const artifact = new URL("../../widget/dist/widget.min.js", import.meta.url);
export async function widgetArtifact() {
  const bytes = await readFile(artifact);
  if (bytes.length === 0 || gzipSync(bytes).length > 30 * 1024)
    throw new Error("Widget build exceeds its bound.");
  return {
    bytes,
    etag: '"' + createHash("sha256").update(bytes).digest("hex") + '"',
  };
}
