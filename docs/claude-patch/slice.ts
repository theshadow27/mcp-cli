#!/usr/bin/env bun
/**
 * slice.ts — dump a printable window around a byte offset (or around the
 * first match of a string) inside a Bun-compiled claude binary.
 *
 * Usage:
 *   bun slice.ts <binary> <offset> [before] [after]
 *   bun slice.ts <binary> --find <string> [before] [after]
 *   bun slice.ts <binary> --grep <regex>   # print every printable run matching regex (whole bundle)
 */
import { readFileSync } from "node:fs";

const [, , binPath, a1, a2, a3] = process.argv;
if (!binPath) {
  console.error("need binary path");
  process.exit(1);
}
const buf = readFileSync(binPath);

function printable(slice: Uint8Array): string {
  let s = "";
  for (const b of slice) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
  return s;
}

if (a1 === "--find") {
  const needle = Buffer.from(a2 ?? "", "utf-8");
  const before = Number(a3 ?? 4000);
  const after = before;
  let i = buf.indexOf(needle, 0);
  let n = 0;
  while (i !== -1) {
    n++;
    const start = Math.max(0, i - before);
    const end = Math.min(buf.length, i + needle.length + after);
    console.log(`--- match #${n} at offset ${i} ---`);
    console.log(printable(buf.subarray(start, end)));
    i = buf.indexOf(needle, i + needle.length);
  }
  console.log(`(total ${n} matches)`);
} else if (a1 === "--grep") {
  // extract all printable runs >= 8 chars, then regex-match
  const re = new RegExp(a2 ?? ".", "g");
  let run = "";
  let runStart = 0;
  const emit = (start: number, text: string) => {
    if (text.length < 8) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const ctxStart = Math.max(0, m.index - 60);
      const ctxEnd = Math.min(text.length, m.index + m[0].length + 60);
      console.log(`@${start + m.index}: ...${text.slice(ctxStart, ctxEnd)}...`);
      if (m.index === re.lastIndex) re.lastIndex++;
      m = re.exec(text);
    }
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) {
      if (run === "") runStart = i;
      run += String.fromCharCode(b);
    } else {
      if (run.length >= 8) emit(runStart, run);
      run = "";
    }
  }
  if (run.length >= 8) emit(runStart, run);
} else {
  const off = Number(a1);
  const before = Number(a2 ?? 4000);
  const after = Number(a3 ?? 4000);
  const start = Math.max(0, off - before);
  const end = Math.min(buf.length, off + after);
  console.log(printable(buf.subarray(start, end)));
}
