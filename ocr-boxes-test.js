// Self-check for parseOcrTsvLines (the /api/ocr?boxes=1 line grouper).
const assert = require("assert");
const { parseOcrTsvLines } = require("./server.js");

// Two words on line 1, one on line 2 (block|par|line groups them). Header row is skipped.
const tsv = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "5\t1\t1\t1\t1\t1\t400\t100\t30\t20\t95\t1x",
  "5\t1\t1\t1\t1\t2\t440\t102\t120\t22\t93\tAldur's",   // same line, extends bbox right + down
  "5\t1\t1\t1\t2\t1\t400\t140\t80\t20\t90\t10x",         // next line
  "5\t1\t2\t1\t1\t1\t\t\t\t\t\t",                        // empty text → ignored
].join("\n");

const lines = parseOcrTsvLines(tsv);
assert.strictEqual(lines.length, 2, "should group into 2 lines");
assert.strictEqual(lines[0].text, "1x Aldur's", "line 1 words joined in order");
assert.strictEqual(lines[0].x, 400, "line bbox starts at leftmost word");
assert.strictEqual(lines[0].w, 160, "line bbox spans to rightmost word edge (440+120-400)");
assert.strictEqual(lines[0].h, 24, "line bbox spans to lowest word bottom (102+22-100)");
assert.strictEqual(lines[1].text, "10x", "line 2");
assert.strictEqual(parseOcrTsvLines("").length, 0, "empty input → no lines");

console.log("ocr-boxes-test: OK");
