import { spawn } from "node:child_process";
import { AppError } from "./store.js";

export type DocumentAttachment = { data: string; mime_type: string; filename: string };

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 48_000;
const MAX_OUTPUT = 1024 * 1024;
const plainExtensions = new Set([
  "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm",
  "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "h", "cpp", "hpp",
  "cs", "rb", "php", "sh", "bash", "sql", "toml", "ini", "log", "rst", "tex",
]);
const plainMimes = new Set([
  "application/json", "application/ld+json", "application/x-ndjson", "application/jsonl", "application/xml",
  "application/yaml", "application/x-yaml", "application/javascript", "application/x-javascript",
  "application/typescript", "application/csv", "application/sql", "application/toml",
]);
const officeMimes = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
} as const;

function kind(document: DocumentAttachment): "text" | "pdf" | "docx" | "xlsx" {
  const mime = document.mime_type;
  if (mime in officeMimes) return officeMimes[mime as keyof typeof officeMimes];
  if (mime === "application/pdf") return "pdf";
  const extension = document.filename.split(".").at(-1)?.toLowerCase();
  if (extension === "pdf" || extension === "docx" || extension === "xlsx") return extension;
  if (mime.startsWith("text/") || plainMimes.has(mime) || (extension && plainExtensions.has(extension))) return "text";
  throw new AppError(400, "Send a text, code, CSV, PDF, DOCX, or XLSX document up to 8 MiB.");
}

/** Validate the encrypted attachment before admitting it to the durable inbox. */
export function validateDocument(input: unknown): DocumentAttachment {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(400, "The document attachment is invalid.");
  const value = input as Record<string, unknown>;
  if (typeof value.data !== "string" || typeof value.mime_type !== "string" || typeof value.filename !== "string"
    || !value.filename.trim() || value.filename.length > 512 || value.mime_type.length > 200)
    throw new AppError(400, "The document attachment is invalid.");
  if (value.data.length > Math.ceil(MAX_BYTES / 3) * 4) throw new AppError(413, "Documents must be no larger than 8 MiB.");
  if (!value.data || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
    throw new AppError(400, "The document attachment has invalid encoded data.");
  const bytes = Buffer.from(value.data, "base64");
  if (!bytes.length || bytes.toString("base64") !== value.data) throw new AppError(400, "The document attachment has invalid encoded data.");
  if (bytes.length > MAX_BYTES) throw new AppError(413, "Documents must be no larger than 8 MiB.");
  const filename = value.filename.split(/[\\/]/).at(-1)!
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 255) || "document";
  const mime_type = value.mime_type.split(";", 1)[0].trim().toLowerCase();
  const document = { data: value.data, mime_type, filename };
  kind(document);
  return document;
}

function boundedText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n").trim();
  if (!normalized) throw new AppError(400, "No readable text was found. Scanned PDFs need text recognition before sending.");
  if (normalized.length <= MAX_TEXT) return normalized;
  const suffix = "\n\n[Document text truncated to 48,000 characters.]";
  return normalized.slice(0, MAX_TEXT - suffix.length) + suffix;
}

// Only fixed local parsers receive document bytes on stdin. Model-provided paths or
// commands are never executed, archives are never extracted, and macros never run.
const officeReader = String.raw`
import io, re, sys, zipfile, xml.etree.ElementTree as E
LIMIT = 48000
parts = []
length = 0
def emit(text):
    global length
    if length > LIMIT:
        return
    text = str(text)
    remaining = LIMIT + 128 - length
    if remaining > 0:
        text = text[:remaining]
        parts.append(text)
        length += len(text)
def parse(archive, name):
    info = archive.getinfo(name)
    if info.file_size > 8 * 1024 * 1024 or info.flag_bits & 1:
        raise ValueError()
    data = archive.read(info)
    # Strip encoding padding for this check so UTF-16/32 cannot hide a declaration.
    if re.search(br'<!\s*(DOCTYPE|ENTITY)\b', data.replace(b'\x00', b''), re.I):
        raise ValueError()
    return E.fromstring(data)
def local(tag):
    return tag.rsplit('}', 1)[-1]
def text_nodes(element):
    return ''.join(node.text or '' for node in element.iter() if local(node.tag) == 't')
try:
    content = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(content) > 8 * 1024 * 1024:
        raise ValueError()
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        files = archive.infolist()
        if len(files) > 4096 or sum(info.file_size for info in files) > 32 * 1024 * 1024:
            raise ValueError()
        if any(info.flag_bits & 1 for info in files):
            raise ValueError()
        if any(info.filename.startswith(('/', '\\')) or '..' in info.filename.replace('\\', '/').split('/')
               or ((info.external_attr >> 16) & 0xf000) == 0xa000 for info in files):
            raise ValueError()
        if sys.argv[1] == 'docx':
            document = parse(archive, 'word/document.xml')
            for paragraph in document.iter():
                if local(paragraph.tag) == 'p':
                    value = []
                    for node in paragraph.iter():
                        tag = local(node.tag)
                        if tag == 't': value.append(node.text or '')
                        elif tag == 'tab': value.append('\t')
                        elif tag in ('br', 'cr'): value.append('\n')
                    emit(''.join(value) + '\n')
                    if length > LIMIT: break
        else:
            strings = []
            if 'xl/sharedStrings.xml' in archive.namelist():
                for node in parse(archive, 'xl/sharedStrings.xml'):
                    if local(node.tag) == 'si': strings.append(text_nodes(node))
            titles = {}
            if 'xl/workbook.xml' in archive.namelist():
                for node in parse(archive, 'xl/workbook.xml').iter():
                    if local(node.tag) == 'sheet':
                        titles[node.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')] = node.attrib.get('name', 'Sheet')
            targets = {}
            if 'xl/_rels/workbook.xml.rels' in archive.namelist():
                for node in parse(archive, 'xl/_rels/workbook.xml.rels'):
                    target = node.attrib.get('Target', '')
                    if node.attrib.get('TargetMode') != 'External':
                        targets['xl/' + target.lstrip('/')] = titles.get(node.attrib.get('Id'), 'Sheet')
                        targets[target.lstrip('/')] = titles.get(node.attrib.get('Id'), 'Sheet')
            sheets = sorted(name for name in archive.namelist() if re.fullmatch(r'xl/worksheets/sheet[0-9]+\.xml', name))
            if not sheets: raise ValueError()
            for name in sheets:
                emit('\n[' + targets.get(name, name.rsplit('/', 1)[-1]) + ']\n')
                for row in parse(archive, name).iter():
                    if local(row.tag) != 'row': continue
                    values = []
                    for cell in row:
                        if local(cell.tag) != 'c': continue
                        cell_type = cell.attrib.get('t')
                        raw = next((child.text or '' for child in cell if local(child.tag) == 'v'), '')
                        if cell_type == 's':
                            index = int(raw)
                            if index < 0 or index >= len(strings): raise ValueError()
                            value = strings[index]
                        elif cell_type == 'inlineStr': value = text_nodes(cell)
                        elif cell_type == 'b': value = 'TRUE' if raw == '1' else 'FALSE'
                        else: value = raw
                        match = re.fullmatch(r'([A-Z]{1,3})[0-9]+', cell.attrib.get('r', ''))
                        column = len(values)
                        if match:
                            column = 0
                            for character in match.group(1): column = column * 26 + ord(character) - 64
                            column -= 1
                        # Sparse spreadsheet coordinates must not create huge empty output.
                        if column > 255: continue
                        while len(values) < column: values.append('')
                        if column == len(values): values.append(value)
                        else: values[column] = value
                    if any(values): emit('\t'.join(values) + '\n')
                    if length > LIMIT: break
                if length > LIMIT: break
    sys.stdout.write(''.join(parts))
except Exception:
    sys.exit(2)
`;

function parseWith(command: string, args: string[], input: Buffer, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0, stderrBytes = 0, settled = false;
    const finish = (error?: AppError, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); }
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new AppError(400, `${label} text extraction took too long. Send a smaller document.`)), 10_000);
    timer.unref();
    child.once("error", (error: NodeJS.ErrnoException) => finish(new AppError(error.code === "ENOENT" ? 503 : 400,
      error.code === "ENOENT" ? `${label} document support is unavailable on this server.` : `The ${label} document could not be read.`)));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(new AppError(413, "The extracted document is too large. Send a smaller document."));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) finish(new AppError(400, `The ${label} document could not be read.`));
    });
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      if (code !== 0) finish(new AppError(400, `The ${label} document could not be read. It may be corrupt, encrypted, or unsupported.`));
      else finish(undefined, Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

/** Extract text locally without granting the model a filesystem or shell tool. */
export async function extractDocument(input: DocumentAttachment): Promise<string> {
  const document = validateDocument(input), bytes = Buffer.from(document.data, "base64"), format = kind(document);
  if (format === "text") {
    let text: string;
    try {
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw new Error();
    } catch { throw new AppError(400, "The document is not readable UTF-8 or UTF-16 text. Send a supported document format."); }
    return boundedText(text);
  }
  if (format === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new AppError(400, "The attachment is not a valid PDF document.");
    return boundedText(await parseWith("pdftotext", ["-layout", "-", "-"], bytes, "PDF"));
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new AppError(400, `The attachment is not a valid ${format.toUpperCase()} document.`);
  return boundedText(await parseWith("python3", ["-I", "-c", officeReader, format], bytes, format.toUpperCase()));
}
