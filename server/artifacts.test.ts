import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { analyzeData, exportFile } from "./artifacts.js";

const python = process.env.FAMILY_PYTHON_BIN || "python3";
const graphics = spawnSync(python, ["-I", "-c", "import matplotlib,reportlab"], { stdio: "ignore" }).status === 0;
const pdfText = spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).status === 0;

test("CSV exports preserve Chinese, quotes, line breaks, and numeric negatives while disabling formulas", async () => {
  const file = await exportFile({ format: "csv", filename: "../../家庭:预算?.exe", columns: ["项目", "备注", "金额"], rows: [
    ["食品", '他说"你好"\n下行', -20], ["=IMPORTXML(\"https://invalid.test\")", "  @SUM(A1)", "+cmd"],
  ] });
  assert.equal(file.name, "家庭预算.csv");
  assert.equal(file.mimeType, "text/csv");
  const text = Buffer.from(file.data, "base64").toString("utf8");
  assert.ok(text.startsWith("\uFEFF"));
  assert.match(text, /"项目","备注","金额"/);
  assert.match(text, /"他说""你好""\n下行","-20"/);
  assert.match(text, /"'=IMPORTXML/);
  assert.match(text, /"'  @SUM\(A1\)","'\+cmd"/);
});

test("export validation rejects unknown formats, invalid tables, oversized cells, and cancelled operations", async () => {
  await assert.rejects(exportFile({ format: "exe", columns: ["x"], rows: [[1]] }), /CSV or PDF/);
  await assert.rejects(exportFile({ format: "csv", columns: ["x"], rows: [[1, 2]] }), /column count/);
  await assert.rejects(exportFile({ format: "csv", columns: ["x"], rows: [["x".repeat(4097)]] }), /Table cells/);
  await assert.rejects(exportFile({ format: "csv", columns: ["x"], rows: [[Infinity]] }), /finite numbers/);
  await assert.rejects(exportFile({ format: "csv", columns: ["x"], rows: [["a\u0001b"]] }), /control characters/);
  await assert.rejects(exportFile({ format: "csv", columns: ["x\u0085"], rows: [[1]] }), /control characters/);
  await assert.rejects(exportFile({ format: "csv", columns: ["x"], rows: [[1]], command: "echo forbidden" }), /unsupported/);
  await assert.rejects(exportFile({ format: "pdf", text: "x", rows: [[1]] }), /column names/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportFile({ format: "csv", columns: ["x"], rows: [[1]] }, controller.signal), /cancelled/);
});

test("fixed Python descriptive statistics handle missing values and grouped household data accurately", async () => {
  const rows = [{ category: "食品", amount: 10, units: 1 }, { category: "食品", amount: 30, units: 3 }, { category: "交通", amount: null, units: 2 }];
  const described = JSON.parse((await analyzeData({ rows, columns: ["amount"] })).text);
  assert.equal(described.rows, 3);
  assert.deepEqual(described.columns.amount, { count: 2, missing: 1, sum: 40, min: 10, max: 30, mean: 20, median: 20, stdev: Math.sqrt(200), q1: 15, q3: 25 });
  const grouped = JSON.parse((await analyzeData({ rows, operation: "group", group_by: "category", value_column: "amount", aggregation: "mean" })).text);
  assert.deepEqual(grouped.groups, [{ category: "食品", value: 20, count: 2 }, { category: "交通", value: null, count: 0 }]);
  const counted = JSON.parse((await analyzeData({ rows, operation: "group", group_by: "category", aggregation: "count" })).text);
  assert.deepEqual(counted.groups.map((row: any) => row.value), [2, 1]);
});

test("Python correlation uses paired values and reports constant columns without producing NaN", async () => {
  const result = JSON.parse((await analyzeData({ operation: "correlation", columns: ["x", "y", "constant"], rows: [
    { x: 1, y: 2, constant: 5 }, { x: 2, y: 4, constant: 5 }, { x: 3, y: null, constant: 5 }, { x: 4, y: 8, constant: 5 },
  ] })).text);
  assert.deepEqual(result.pairs[0], { x: "x", y: "y", count: 3, correlation: 1 });
  assert.equal(result.pairs[1].correlation, null);
  assert.equal(result.pairs[2].correlation, null);
});

test("analysis accepts only bounded declarative data, never a Python program or filesystem path", async () => {
  await assert.rejects(analyzeData({ rows: [{ x: 1 }], code: "__import__('os').environ" }), /unsupported/);
  await assert.rejects(analyzeData({ rows: [{ x: 1 }], path: "/etc/passwd" }), /unsupported/);
  await assert.rejects(analyzeData({ rows: [{ x: 1 }], operation: "exec" }), /describe, group, or correlation/);
  await assert.rejects(analyzeData({ rows: [{ x: 1 }], chart: { type: "bar", source: "file:///etc/passwd" } }), /unsupported/);
  await assert.rejects(analyzeData({ rows: [{ x: 1 }], chart: { type: "histogram", bins: 1000000 } }), /bins/);
  await assert.rejects(analyzeData({ rows: [{ x: 1 }], group_by: "missing", operation: "group", aggregation: "count" }), /not present/);
  await assert.rejects(analyzeData({ rows: Array.from({ length: 5001 }, () => ({ x: 1 })) }), /5,000/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeData({ rows: [{ x: 1 }] }, controller.signal), /cancelled/);
});

test("cancelling an active Python worker prevents a late chart or statistics result", async () => {
  const controller = new AbortController();
  const result = analyzeData({ rows: [{ x: 1, y: 2 }, { x: 2, y: 4 }], chart: { type: "scatter", x: "x", y: "y" } }, controller.signal);
  controller.abort();
  await assert.rejects(result, /cancelled/);
});

test("PDF export renders Chinese paragraphs and table content as extractable PDF text", {
  skip: (!graphics || !pdfText) && "Install the plotting/PDF worker dependencies and Poppler to run this regression.",
}, async () => {
  const file = await exportFile({ format: "pdf", filename: "家庭预算", title: "家庭预算", text: "这是本月支出。\n原样显示 <b>文字</b>。", columns: ["项目", "金额"], rows: [["食品", 42], ["交通", 15]] });
  const bytes = Buffer.from(file.data, "base64");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const result = spawnSync("pdftotext", ["-", "-"], { input: bytes, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /家庭预算/);
  assert.match(result.stdout, /食品/);
  assert.match(result.stdout, /<b>文字<\/b>/);
  assert.match(result.stdout, /42/);
});

test("Python charts return an actual PNG and keep grouped statistics over all data", {
  skip: !graphics && "Install the plotting worker dependencies to run this regression.",
}, async () => {
  const result = await analyzeData({ rows: [{ 月份: "一月", 金额: 10 }, { 月份: "二月", 金额: 25 }, { 月份: "三月", 金额: 15 }], columns: ["金额"], chart: { type: "bar", x: "月份", y: "金额", title: "家庭支出" } });
  assert.equal(JSON.parse(result.text).columns.金额.mean, 50 / 3);
  assert.equal(result.images.length, 1);
  const bytes = Buffer.from(result.images[0].data, "base64");
  assert.ok(bytes.length > 3000);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.equal(bytes.readUInt32BE(16), 1120);
  assert.equal(bytes.readUInt32BE(20), 700);
});
