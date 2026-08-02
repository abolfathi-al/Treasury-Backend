import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const ACCOUNTING_REPRESENTATIONS = ['CSV_ZIP_MANIFEST', 'XLSX'] as const;
export const ACCOUNTING_ACK_OUTCOMES = [
  'ACCEPTED',
  'REJECTED',
  'OUTCOME_UNKNOWN',
  'RETURNED',
] as const;

export type AccountingRepresentation = typeof ACCOUNTING_REPRESENTATIONS[number];
export type AccountingAcknowledgementOutcome = typeof ACCOUNTING_ACK_OUTCOMES[number];

export class ExportRequestDto {
  @IsUUID() accountingSystemId!: string;
  @IsIn(['PAYMENT']) sourceType!: 'PAYMENT';
  @IsUUID() sourceId!: string;
  @IsInt() @Min(0) sourceVersion!: number;
  @IsString() @MaxLength(64) exportKind!: string;
}

export class ExportAcknowledgementDto {
  @IsIn(ACCOUNTING_ACK_OUTCOMES) outcome!: AccountingAcknowledgementOutcome;
  @ValidateIf((value: ExportAcknowledgementDto) => value.outcome === 'ACCEPTED'
    || value.outcome === 'RETURNED')
  @IsString() @MinLength(1) @MaxLength(128) externalDocumentId?: string;
  @IsOptional() @IsString() @MaxLength(128) externalDocumentNumber?: string;
  @Matches(/^[a-f0-9]{64}$/u) responseDigest!: string;
  @ValidateIf((value: ExportAcknowledgementDto) => value.outcome === 'REJECTED'
    || value.outcome === 'RETURNED')
  @IsString() @MinLength(1) @MaxLength(64) errorCode?: string;
  @IsOptional() @IsString() @MaxLength(2000) errorDetail?: string;
  @ValidateIf((value: ExportAcknowledgementDto) => value.outcome === 'RETURNED')
  @IsString() @MinLength(1) @MaxLength(128) externalReturnId?: string;
  @IsDateString() acknowledgedAt!: string;
}

export interface AccountingSystemQuery {
  limit?: string;
  cursor?: string;
}

export interface AccountingExportQuery {
  limit?: string;
  cursor?: string;
}

export interface AccountingFileQuery {
  representation?: string;
}

export interface AccountingSemanticRef {
  id: string;
  label: string;
}

export interface AccountingSystemView {
  id: string;
  code: string;
  name: string;
  transportProfile: AccountingRepresentation;
  contractVersion: string;
  supportedSourceTypes: ['PAYMENT'];
}

export interface AccountingSystemPage {
  items: AccountingSystemView[];
  page: { limit: number; hasMore: boolean; asOf: string; nextCursor?: string };
}

export interface ExportRowResult {
  rowNumber: number;
  sourceType: 'PAYMENT';
  sourceId: string;
  sourceVersion: number;
  payloadDigest: string;
  outcome: 'ACCEPTED';
}

export interface ExportArtifactView {
  id: string;
  representation: AccountingRepresentation;
  contractVersion: string;
  manifestVersion: string;
  mediaType: 'application/zip'
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  fileName: string;
  byteSize: number;
  payloadDigest: string;
  rowCount: number;
  createdAt: string;
  rowResults: ExportRowResult[];
}

export interface AccountingExportView {
  id: string;
  organization: AccountingSemanticRef;
  accountingSystem: AccountingSemanticRef;
  branch?: AccountingSemanticRef;
  treasuryUnit?: AccountingSemanticRef;
  sourceType: 'PAYMENT';
  source: AccountingSemanticRef;
  sourceVersion: number;
  exportKind: string;
  contractVersion: string;
  payloadDigest: string;
  state: 'QUEUED' | 'SENDING' | 'SENDING_UNKNOWN' | 'ACCEPTED' | 'FAILED' | 'RETURNED';
  version: number;
  createdAt: string;
  acceptedAt?: string;
  externalDocumentId?: string;
  externalDocumentNumber?: string;
  artifacts: ExportArtifactView[];
}

export interface AccountingExportPage {
  items: AccountingExportView[];
  page: { limit: number; hasMore: boolean; asOf: string; nextCursor?: string };
}

export interface AccountingAcknowledgementResult {
  acknowledgementId: string;
  outcome: AccountingAcknowledgementOutcome;
  export: AccountingExportView;
  postingLock?: AccountingSemanticRef;
}

export interface AccountingDownload {
  bytes: Buffer;
  mediaType: string;
  fileName: string;
  etag: string;
}
