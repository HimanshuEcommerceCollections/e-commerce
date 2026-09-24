import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { InvalidImportFileError } from '../../common/errors';
import { ALL_COLUMNS, ImportRow, keyOf, normalizeHeader } from './columns';

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
}

export interface ParsedFile {
  /** Normalized headers in file order, duplicates removed. */
  headers: string[];
  rows: ImportRow[];
}

/**
 * Reads the master sheet of an import file — a UTF-8 CSV, or the first
 * worksheet of an .xlsx workbook — into rows. Checks the file's shape only
 * (type, header, row count); cell contents are validated by the import service.
 */
export class CatalogFileReader {
  constructor(private readonly maxRows: number) {}

  async read(file: UploadedFile | undefined): Promise<ParsedFile> {
    if (!file || file.buffer.length === 0) {
      throw new InvalidImportFileError('The uploaded file is empty');
    }
    const name = file.originalname.toLowerCase();
    let table: { rowNumber: number; cells: string[] }[];
    if (name.endsWith('.csv')) {
      table = readCsv(file.buffer);
    } else if (name.endsWith('.xlsx')) {
      table = await readExcel(file.buffer);
    } else {
      // Legacy binary .xls is not supported by the TypeScript server (the Java
      // server's Apache POI read it); save the sheet as .xlsx or .csv.
      throw new InvalidImportFileError('Unsupported file type: upload a .csv or .xlsx file');
    }
    if (table.length === 0) {
      throw new InvalidImportFileError('The file has no header row');
    }
    return this.toParsedFile(table);
  }

  private toParsedFile(table: { rowNumber: number; cells: string[] }[]): ParsedFile {
    const headers = table[0].cells.map(normalizeHeader);

    const missing = ALL_COLUMNS.filter((c) => c.requiredColumn && !headers.includes(keyOf(c))).map((c) => c.header);
    if (missing.length) {
      throw new InvalidImportFileError(`Missing required columns: ${missing.join(', ')}`);
    }

    const rows: ImportRow[] = [];
    for (const { rowNumber, cells } of table.slice(1)) {
      if (cells.every((c) => !c || c.trim() === '')) continue;
      if (rows.length === this.maxRows) {
        throw new InvalidImportFileError(
          `The file has more than ${this.maxRows} data rows; split it into smaller files`,
        );
      }
      const values = new Map<string, string>();
      headers.forEach((header, i) => {
        // First occurrence of a repeated header wins.
        if (i < cells.length && !values.has(header)) values.set(header, cells[i] ?? '');
      });
      rows.push(new ImportRow(rowNumber, values));
    }
    if (rows.length === 0) {
      throw new InvalidImportFileError('The file has a header row but no data rows');
    }
    return { headers: [...new Set(headers)].filter((h) => h !== ''), rows };
  }
}

function readCsv(buffer: Buffer) {
  let records: string[][];
  try {
    // Empty lines are kept (and skipped later as blank rows) so record numbers
    // stay equal to line numbers for the per-row error report.
    records = parse(buffer, {
      bom: true,
      trim: true,
      relax_column_count: true,
      skip_empty_lines: false,
    }) as string[][];
  } catch (e) {
    const line = (e as { lines?: number }).lines;
    throw new InvalidImportFileError(`The CSV file is malformed${line ? ` near line ${line}` : ''}`);
  }
  return records.map((cells, i) => ({ rowNumber: i + 1, cells }));
}

async function readExcel(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    // Corrupt zip, not OOXML, encrypted… to the uploader they all mean the same.
    throw new InvalidImportFileError('The file could not be read as an Excel workbook');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const table: { rowNumber: number; cells: string[] }[] = [];
  let width = -1;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (width < 0) width = Math.max(row.cellCount, 0);
    const cells: string[] = [];
    for (let col = 1; col <= width; col++) cells.push(cellText(row.getCell(col).value));
    table.push({ rowNumber: row.number, cells });
  });
  return table;
}

/**
 * Cell value as text. Numbers are written plainly (499.5, not "4.995E2") so
 * prices, quantities and numeric SKUs survive; dates become yyyy-mm-dd.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return plainNumber(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('').trim();
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result;
      return result === undefined || (typeof result === 'object' && result && 'error' in result)
        ? ''
        : cellText(result);
    }
    if ('text' in value && 'hyperlink' in value) return String(value.text).trim();
    if ('error' in value) return '';
  }
  return String(value).trim();
}

function plainNumber(n: number): string {
  const s = String(n);
  return /e/i.test(s) ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : s;
}
