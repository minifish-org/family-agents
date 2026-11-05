import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "./store.js";

const MAX_OUTPUT = 12 * 1024 * 1024;
const worker = String.raw`
import base64, io, json, math, os, resource, statistics, sys
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (96, 96))
MAX = 8 * 1024 * 1024

def packed(data, mime, name):
    if not data or len(data) > MAX: raise ValueError('output_size')
    return {'data': base64.b64encode(data).decode('ascii'), 'mimeType': mime, 'name': name}

def number(value):
    if isinstance(value, bool) or value is None: return None
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError): return None

def render_pdf(task):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, LongTable, TableStyle
    from xml.sax.saxutils import escape
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    output = io.BytesIO()
    columns, rows = task.get('columns', []), task.get('rows', [])
    page = landscape(A4) if len(columns) > 6 else A4
    usable = page[0] - 72
    style = ParagraphStyle('body', fontName='STSong-Light', fontSize=10, leading=15, wordWrap='CJK', alignment=TA_LEFT)
    cell_style = ParagraphStyle('cell', parent=style, fontSize=8 if len(columns) > 6 else 9, leading=12)
    title_style = ParagraphStyle('title', parent=style, fontSize=17, leading=24, spaceAfter=12)
    story = []
    if task.get('title'): story.append(Paragraph(escape(task['title']), title_style))
    for paragraph in task.get('text', '').split('\n'):
        if paragraph.strip(): story.append(Paragraph(escape(paragraph).replace('\t', '    '), style))
        else: story.append(Spacer(1, 7))
    if columns:
        story.append(Spacer(1, 10))
        values = [columns] + rows
        table = LongTable([[Paragraph(escape('' if v is None else str(v)), cell_style) for v in row] for row in values],
                          colWidths=[usable / len(columns)] * len(columns), repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e9eef5')),
            ('GRID', (0, 0), (-1, -1), .35, colors.HexColor('#c7ced8')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ]))
        story.append(table)
    SimpleDocTemplate(output, pagesize=page, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36,
                      title=task.get('title', 'Family Agent export'), author='Family Agents').build(story)
    return packed(output.getvalue(), 'application/pdf', task['filename'])

def analysis(task):
    rows, operation = task['rows'], task['operation']
    keys = list(rows[0])
    numeric = task.get('columns') or [key for key in keys if any(number(row.get(key)) is not None for row in rows)]
    result = {'operation': operation, 'rows': len(rows)}
    plot_rows, plot_x, plot_y = rows, None, None
    if operation == 'describe':
        summaries = {}
        for key in numeric:
            data = [value for row in rows if (value := number(row.get(key))) is not None]
            if not data:
                summaries[key] = {'count': 0, 'missing': len(rows)}
                continue
            quartiles = statistics.quantiles(data, n=4, method='inclusive') if len(data) > 1 else [data[0]] * 3
            summaries[key] = {'count': len(data), 'missing': len(rows) - len(data), 'sum': math.fsum(data),
                              'min': min(data), 'max': max(data), 'mean': statistics.mean(data),
                              'median': statistics.median(data), 'stdev': statistics.stdev(data) if len(data) > 1 else 0,
                              'q1': quartiles[0], 'q3': quartiles[2]}
        if not any(v['count'] for v in summaries.values()): raise ValueError('numeric')
        result['columns'] = summaries
    elif operation == 'group':
        group, value, aggregation = task['group_by'], task.get('value_column'), task.get('aggregation', 'sum')
        grouped = {}
        for row in rows:
            label = '' if row.get(group) is None else str(row[group])
            if label not in grouped:
                if len(grouped) >= 100: raise ValueError('groups')
                grouped[label] = []
            if aggregation == 'count': grouped[label].append(1)
            elif (parsed := number(row.get(value))) is not None: grouped[label].append(parsed)
        output = []
        for label, data in grouped.items():
            calculated = len(data) if aggregation == 'count' else (math.fsum(data) if aggregation == 'sum' else statistics.mean(data)) if data else None
            output.append({group: label, 'value': calculated, 'count': len(data)})
        result.update({'group_by': group, 'aggregation': aggregation, 'groups': output})
        plot_rows, plot_x, plot_y = output, group, 'value'
    elif operation == 'correlation':
        if len(numeric) < 2: raise ValueError('numeric')
        correlations = []
        for index, left in enumerate(numeric):
            for right in numeric[index + 1:]:
                pairs = [(a, b) for row in rows if (a := number(row.get(left))) is not None and (b := number(row.get(right))) is not None]
                value = None
                if len(pairs) >= 2:
                    try: value = statistics.correlation([p[0] for p in pairs], [p[1] for p in pairs])
                    except statistics.StatisticsError: pass
                correlations.append({'x': left, 'y': right, 'count': len(pairs), 'correlation': value})
        result['pairs'] = correlations
    images = []
    if chart := task.get('chart'):
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from matplotlib import font_manager
        matplotlib.rcParams.update({'text.usetex': False, 'text.parse_math': False, 'axes.unicode_minus': False})
        for font in font_manager.fontManager.ttflist:
            if 'Noto Sans CJK' in font.name:
                matplotlib.rcParams['font.family'] = font.name
                break
        kind = chart['type']
        xkey = plot_x or chart.get('x') or keys[0]
        ykey = plot_y or chart.get('y') or (numeric[0] if numeric else keys[0])
        fig, ax = plt.subplots(figsize=(8, 5), dpi=140)
        if kind == 'histogram':
            values = [v for row in plot_rows if (v := number(row.get(ykey))) is not None]
            if not values: raise ValueError('chart_numeric')
            ax.hist(values, bins=chart.get('bins', 20), color='#3478bb', edgecolor='white')
            ax.set_xlabel(ykey); ax.set_ylabel('Count')
        elif kind == 'scatter':
            pairs = [(x, y) for row in plot_rows if (x := number(row.get(xkey))) is not None and (y := number(row.get(ykey))) is not None]
            if not pairs: raise ValueError('chart_numeric')
            ax.scatter([p[0] for p in pairs], [p[1] for p in pairs], color='#3478bb', alpha=.75)
            ax.set_xlabel(xkey); ax.set_ylabel(ykey)
        else:
            selected = plot_rows[:100] if kind == 'bar' else plot_rows
            pairs = [(str(row.get(xkey, ''))[:40], y) for row in selected if (y := number(row.get(ykey))) is not None]
            if not pairs: raise ValueError('chart_numeric')
            positions = list(range(len(pairs)))
            if kind == 'bar': ax.bar(positions, [p[1] for p in pairs], color='#3478bb')
            else: ax.plot(positions, [p[1] for p in pairs], color='#3478bb', marker='o' if len(pairs) <= 50 else None)
            step = max(1, math.ceil(len(pairs) / 15))
            ticks = positions[::step]
            ax.set_xticks(ticks, [pairs[i][0] for i in ticks], rotation=35, ha='right')
            ax.set_xlabel(xkey); ax.set_ylabel(ykey)
            if len(selected) < len(plot_rows): result['chart_note'] = 'Bar chart shows the first 100 records; statistics use all rows.'
        ax.set_title(chart.get('title', '')[:160]); ax.grid(axis='y', alpha=.2)
        fig.tight_layout()
        output = io.BytesIO(); fig.savefig(output, format='png'); plt.close(fig)
        images.append(packed(output.getvalue(), 'image/png', 'analysis.png'))
    return {'statistics': result, 'images': images}

try:
    payload = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(payload) > 2 * 1024 * 1024: raise ValueError('input_size')
    task = json.loads(payload)
    result = render_pdf(task) if task['task'] == 'pdf' else analysis(task)
    sys.stdout.write(json.dumps({'ok': True, 'result': result}, ensure_ascii=False, allow_nan=False))
except ModuleNotFoundError:
    sys.stdout.write('{"ok":false,"error":"dependencies"}')
except Exception:
    sys.stdout.write('{"ok":false,"error":"invalid_data"}')
`;

/** Runs only the fixed declarative worker; user code, import names, and paths are never accepted. */
export function runPython(task: unknown, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) return Promise.reject(new AppError(409, "The analysis was cancelled."));
  const input = JSON.stringify(task);
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) return Promise.reject(new AppError(413, "The data is too large. Send a smaller table."));
  const temporary = mkdtempSync(join(tmpdir(), "family-analysis-"));
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: temporary, TMPDIR: temporary,
      MPLCONFIGDIR: temporary, MPLBACKEND: "Agg", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const child = spawn(process.env.FAMILY_PYTHON_BIN || "python3", ["-I", "-c", worker], { cwd: temporary, env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let outputBytes = 0, stderrBytes = 0, failure: AppError | undefined, completed = false;
    const fail = (error: AppError) => { if (!failure) failure = error; child.kill("SIGKILL"); };
    const abort = () => fail(new AppError(409, "The analysis was cancelled."));
    const timer = setTimeout(() => fail(new AppError(400, "The analysis took too long. Use a smaller dataset.")), 30_000);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = new AppError(503, error.code === "ENOENT" ? "Python analysis is unavailable on this server." : "Python analysis could not start.");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) fail(new AppError(413, "The analysis output is too large."));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 256 * 1024) fail(new AppError(400, "The analysis could not be completed. Check the data and chart labels."));
    });
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); rmSync(temporary, { recursive: true, force: true });
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new AppError(400, "The analysis exceeded its resource limits or could not finish.")); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) throw new AppError(result.error === "dependencies" ? 503 : 400,
          result.error === "dependencies" ? "Python plotting or PDF support is unavailable on this server." : "The requested analysis or PDF could not be created. Check the data and reduce large tables.");
        resolve(result.result);
      } catch (error) { reject(error instanceof AppError ? error : new AppError(400, "The analysis returned an invalid result.")); }
    });
    child.stdin.end(input);
  });
}
