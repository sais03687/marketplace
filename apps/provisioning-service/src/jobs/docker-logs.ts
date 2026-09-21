/** Docker's log stream with the per-frame header removed.
 *
 * With no TTY attached, `container.logs` returns frames of
 * `[stream, 0, 0, 0, length (4 bytes, big-endian)]` followed by `length` bytes
 * of output. Deleting control characters is not enough to undo that: a frame
 * 35 bytes long carries a printable "#" in its length field, and 50, 61 and 93
 * carry "2", "=" and "]" — which survive the strip and land at the start of a
 * line, reading as part of the creator's traceback.
 *
 * Kept in its own module with no imports so its test can run it directly.
 */
export function demuxDockerLogs(raw: Buffer | string): string {
  const strip = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
  if (!Buffer.isBuffer(raw)) return strip(String(raw));

  const frames: string[] = [];
  let at = 0;
  while (at + 8 <= raw.length) {
    const length = raw.readUInt32BE(at + 4);
    // A real header names a known stream (0/1/2), pads with three zero bytes,
    // and declares a length that fits in what is left.
    const framed =
      raw[at] <= 2 && raw[at + 1] === 0 && raw[at + 2] === 0 && raw[at + 3] === 0 &&
      at + 8 + length <= raw.length;
    if (!framed) break;
    frames.push(raw.toString("utf8", at + 8, at + 8 + length));
    at += 8 + length;
  }

  // Never framed at all — some Docker setups hand back plain text.
  if (at === 0) return strip(raw.toString("utf8"));
  // A trailing partial frame, which `tail` can leave behind.
  if (at < raw.length) frames.push(strip(raw.toString("utf8", at)));
  return frames.join("");
}
