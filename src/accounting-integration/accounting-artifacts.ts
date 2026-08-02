import { createHash } from 'node:crypto';

import { stableJson } from '../common/http';
import type { AccountingRepresentation } from './accounting.dto';

export interface FrozenAccountingPayload {
  createdAt: string;
  contractVersion: string;
  exportKind: string;
  organization: { id: string; code: string; name: string };
  accountingSystem: { id: string; code: string; name: string };
  source: {
    id: string;
    version: number;
    businessNumber: string;
    businessDate: string;
    baseCurrency: string;
    totalBaseAmount: string;
  };
  fiscalPeriod: { externalKey: string; sourceVersion: string; sourceDigest: string };
  mappings: Array<{
    localType: string;
    localId: string;
    mappingType: string;
    externalKey: string;
    externalParentKey: string | null;
    sourceVersion: string | null;
  }>;
  lines: Array<{
    lineNumber: number;
    methodName: string;
    amount: string;
    currency: string;
    baseAmount: string;
    description: string | null;
  }>;
}

export interface BuiltArtifact {
  representation: AccountingRepresentation;
  mediaType: 'application/zip'
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  fileName: string;
  bytes: Buffer;
  payloadDigest: string;
  rowDigests: string[];
}

export function buildArtifacts(payload: FrozenAccountingPayload): BuiltArtifact[] {
  const baseName = safe(`${payload.accountingSystem.code}-${payload.source.businessNumber}`);
  const rows = payload.lines.map((line) => ({
    sourceType: 'PAYMENT',
    sourceId: payload.source.id,
    sourceVersion: payload.source.version,
    businessNumber: payload.source.businessNumber,
    businessDate: payload.source.businessDate,
    exportKind: payload.exportKind,
    accountingSystemCode: payload.accountingSystem.code,
    lineNumber: line.lineNumber,
    methodName: line.methodName,
    amount: line.amount,
    currency: line.currency,
    baseAmount: line.baseAmount,
    baseCurrency: payload.source.baseCurrency,
    description: line.description ?? '',
  }));
  const rowDigests = rows.map((row) => sha(Buffer.from(stableJson(row))));
  const columns = Object.keys(rows[0]!);
  const csv = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column as keyof typeof row])).join(',')),
  ].join('\r\n') + '\r\n';
  const manifest = stableJson({
    manifestVersion: '1',
    canonContract: 'INC-3D-ACCOUNTING-EXPORT-ACK',
    contractVersion: payload.contractVersion,
    createdAt: payload.createdAt,
    exportKind: payload.exportKind,
    organization: payload.organization,
    accountingSystem: payload.accountingSystem,
    source: payload.source,
    fiscalPeriod: payload.fiscalPeriod,
    mappingDigest: sha(Buffer.from(stableJson(payload.mappings))),
    rowCount: rows.length,
    rowDigests,
    files: ['export.csv'],
  });
  const csvZip = zip([
    ['manifest.json', Buffer.from(manifest)],
    ['export.csv', Buffer.from(csv)],
  ]);
  const xlsx = workbook(columns, rows.map((row) => columns.map(
    (column) => String(row[column as keyof typeof row]),
  )));
  return [
    artifact('CSV_ZIP_MANIFEST', 'application/zip', `${baseName}.zip`, csvZip, rowDigests),
    artifact(
      'XLSX',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `${baseName}.xlsx`,
      xlsx,
      rowDigests,
    ),
  ];
}

function artifact(
  representation: AccountingRepresentation,
  mediaType: BuiltArtifact['mediaType'],
  fileName: string,
  bytes: Buffer,
  rowDigests: string[],
): BuiltArtifact {
  return { representation, mediaType, fileName, bytes, payloadDigest: sha(bytes), rowDigests };
}

function workbook(columns: string[], rows: string[][]): Buffer {
  const xmlRows = [columns, ...rows].map((row, rowIndex) =>
    `<row r="${rowIndex + 1}">${row.map((value, columnIndex) =>
      `<c r="${cell(columnIndex, rowIndex)}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`
    ).join('')}</row>`).join('');
  return zip([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')],
    ['xl/workbook.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Accounting Export" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`)],
  ]);
}

function zip(entries: Array<[string, Buffer]>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const fileName = Buffer.from(name);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(fileName.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, fileName);
    offset += header.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cell(column: number, row: number): string {
  let value = column + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return `${label}${row + 1}`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function csvCell(value: string | number): string {
  const raw = String(value);
  const text = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'accounting-export';
}

function sha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
