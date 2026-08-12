import { splitByFile } from "./parse.js";

/**
 * Split a diff into chunks of at most `chunkBytes`, only on file boundaries:
 * one file's diff never spans two chunks, and a single file larger than
 * `chunkBytes` becomes its own (oversized) chunk. Diffs that already fit in
 * `chunkBytes` are returned as a single chunk.
 *
 * Chunk order follows file order in the original diff, so concatenating chunk
 * scans in order yields exactly the unchunked scan order.
 */
export function chunkDiff(diff: string, chunkBytes: number): string[] {
  if (Buffer.byteLength(diff, "utf8") <= chunkBytes) {
    return [diff];
  }

  const sections = splitByFile(diff);
  const chunks: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (sectionBytes > chunkBytes) {
      // Oversized single file: own chunk, even above chunkBytes.
      flushCurrent();
      chunks.push(section);
      continue;
    }
    const sepBytes = current.length > 0 ? 1 : 0; // rejoin with "\n"
    const currentBytes = Buffer.byteLength(current, "utf8");
    if (currentBytes + sepBytes + sectionBytes > chunkBytes) {
      flushCurrent();
      current = section;
    } else {
      current = current.length > 0 ? current + "\n" + section : section;
    }
  }
  flushCurrent();

  return chunks.length > 0 ? chunks : [diff];
}
