import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { extractDocument, validateDocument, type DocumentAttachment } from "./documents.js";

const attachment = (content: string | Buffer, filename = "notes.txt", mime_type = "text/plain"): DocumentAttachment => ({
  data: Buffer.from(content).toString("base64"), filename, mime_type,
});
const zip = (entries: Record<string, string>, encoding = "utf-8") => execFileSync("python3", ["-I", "-c", String.raw`
import io,json,sys,zipfile
output=io.BytesIO()
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
    for name,content in json.load(sys.stdin).items(): archive.writestr(name,content.encode(sys.argv[1]))
sys.stdout.buffer.write(output.getvalue())
`, encoding], { input: JSON.stringify(entries), maxBuffer: 12 * 1024 * 1024 });
const docx = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const office = (bytes: Buffer, format: "docx" | "xlsx") => attachment(bytes, `report.${format}`, "application/octet-stream");

test("documents validate supported metadata and canonical base64 before admission", () => {
  assert.deepEqual(validateDocument(attachment("hello", "../../private\\notes.txt", "TEXT/PLAIN; charset=utf-8")), attachment("hello", "notes.txt", "text/plain"));
  for (const value of [null, [], {}, { ...attachment("hello"), data: "a=== " }, { ...attachment("hello"), data: "Zh==" }, { ...attachment("hello"), data: "Zg" }])
    assert.throws(() => validateDocument(value), /invalid/i);
  assert.throws(() => validateDocument(attachment("executable", "run.exe", "application/octet-stream")), /text, code, CSV/);
  assert.throws(() => validateDocument(attachment(Buffer.alloc(8 * 1024 * 1024 + 1))), /8 MiB/);
  assert.equal(validateDocument(attachment("{}", "payload", "application/json")).mime_type, "application/json");
});

test("UTF-8 and UTF-16 documents preserve text and CSV while binary input is rejected", async () => {
  assert.equal(await extractDocument(attachment("姓名,金额\r\n小明,42\r\n", "budget.csv", "text/csv")), "姓名,金额\n小明,42");
  assert.equal(await extractDocument(attachment(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Meeting at 10:30", "utf16le")]))), "Meeting at 10:30");
  await assert.rejects(extractDocument(attachment(Buffer.from([0xff, 0x00, 0xfe]))), /not readable/);
  await assert.rejects(extractDocument(attachment("header\0binary")), /not readable/);
  await assert.rejects(extractDocument(attachment(" \r\n\t")), /No readable text/);
  const large = await extractDocument(attachment("a".repeat(70_000)));
  assert.equal(large.length, 48_000);
  assert.match(large, /Document text truncated/);
});

test("DOCX extraction handles paragraphs, tabs, breaks, and table text without running macros", async () => {
  const bytes = zip({
    "word/document.xml": docx('<w:p><w:r><w:t>Quarterly report</w:t><w:tab/><w:t>2026</w:t><w:br/><w:t>Revenue</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'),
    "word/vbaProject.bin": "raise Exception('Never executed')",
  });
  assert.equal(await extractDocument(office(bytes, "docx")), "Quarterly report\t2026\nRevenue\n42");
});

test("XLSX extraction reads shared strings, inline strings, cached formulas, and sparse columns", async () => {
  const bytes = zip({
    "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": '<sst><si><t>Food</t></si><si><r><t>Monthly </t></r><r><t>total</t></r></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>20</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Milk</t></is></c><c r="B2"><f>10*2</f><v>20</v></c><c r="D2" t="b"><v>1</v></c><c r="XFD2"><v>1000000</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const text = await extractDocument(office(bytes, "xlsx"));
  assert.equal(text, "[Budget]\nFood\t\t20\nMilk\t20\t\tTRUE\nMonthly total");
  assert.doesNotMatch(text, /10\*2|1000000/);
});

test("Office parsing rejects malformed archives, XML entities, traversal, and decompression bombs safely", async () => {
  await assert.rejects(extractDocument(office(Buffer.from("PKnot-a-zip"), "docx")), /could not be read/);
  await assert.rejects(extractDocument(office(zip({ "word/document.xml": '<!DOCTYPE document [<!ENTITY local SYSTEM "file:///etc/passwd">]><document>&local;</document>' }), "docx")), /could not be read/);
  await assert.rejects(extractDocument(office(zip({ "word/document.xml": '<?xml version="1.0" encoding="utf-16"?><!DOCTYPE document [<!ENTITY local "do not expand">]>' + docx('<w:p><w:r><w:t>&local;</w:t></w:r></w:p>') }, "utf-16"), "docx")), /could not be read/);
  await assert.rejects(extractDocument(office(zip({ "word/document.xml": docx(""), "../../escape": "cannot be extracted" }), "docx")), /could not be read/);
  await assert.rejects(extractDocument(office(zip({ "word/document.xml": docx(""), "large.bin": "0".repeat(33 * 1024 * 1024) }), "docx")), /could not be read/);
  await assert.rejects(extractDocument(office(zip({ "word/document.xml": docx(`<w:p><w:r><w:t>${"x".repeat(9 * 1024 * 1024)}</w:t></w:r></w:p>`) }), "docx")), /could not be read/);
});

const pdfAvailable = spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).status === 0;
test("PDF text is extracted by the installed local parser and corrupt files fail without exposing parser diagnostics", {
  skip: !pdfAvailable && "Install poppler-utils to run the local PDF extraction regression.",
}, async () => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const content = "BT /F1 18 Tf 72 720 Td (PDF fixture proof) Tj ET";
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const positions = [0];
  for (const [index, object] of objects.entries()) { positions.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const cross = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${positions.slice(1).map((position) => `${String(position).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${cross}\n%%EOF\n`;
  assert.equal(await extractDocument(attachment(pdf, "report.pdf", "application/pdf")), "PDF fixture proof");
  await assert.rejects(extractDocument(attachment("%PDF-broken-private-file-name", "broken.pdf", "application/pdf")), (error: Error) => /could not be read/.test(error.message) && !error.message.includes("private-file-name"));
});
