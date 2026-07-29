import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

const uppercase = ({ value }: { value: unknown }): unknown => (
  typeof value === 'string' ? value.trim().toUpperCase() : value
);

export enum PrintTemplateDocumentKind {
  RECEIPT = 'RECEIPT',
  PAYMENT = 'PAYMENT',
  TRANSFER = 'TRANSFER',
  CHEQUE = 'CHEQUE',
}

export enum PrintTemplateLanguage {
  FA_IR = 'fa-IR',
  EN = 'en',
}

export enum PrintTemplateDirection {
  RTL = 'RTL',
  LTR = 'LTR',
}

export enum PrintTemplatePageProfile {
  A4_PORTRAIT = 'A4_PORTRAIT',
  A4_LANDSCAPE = 'A4_LANDSCAPE',
  A5_PORTRAIT = 'A5_PORTRAIT',
  A5_LANDSCAPE = 'A5_LANDSCAPE',
  CHEQUE_CUSTOM = 'CHEQUE_CUSTOM',
}

export class PrintTemplateCreateDto {
  @Transform(uppercase)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_-]{1,63}$/u)
  code!: string;

  @IsEnum(PrintTemplateDocumentKind)
  documentKind!: PrintTemplateDocumentKind;

  @IsOptional() @IsUUID() treasuryUnitId?: string;
  @IsOptional() @IsUUID() bankId?: string;
  @IsOptional() @IsUUID() chequeBookId?: string;

  @IsEnum(PrintTemplateLanguage)
  language!: PrintTemplateLanguage;

  @IsEnum(PrintTemplateDirection)
  direction!: PrintTemplateDirection;

  @IsEnum(PrintTemplatePageProfile)
  pageProfile!: PrintTemplatePageProfile;

  @IsOptional() @IsNumber({ allowInfinity: false, allowNaN: false }) @Min(-100) @Max(100)
  calibrationXmm?: number;

  @IsOptional() @IsNumber({ allowInfinity: false, allowNaN: false }) @Min(-100) @Max(100)
  calibrationYmm?: number;

  @IsObject()
  templateBody!: Record<string, unknown>;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/u)
  templateDigest!: string;
}

export interface PrintTemplateScopeReference {
  id: string;
  label: string;
}

export interface PrintTemplateView {
  id: string;
  organizationId: string;
  code: string;
  documentKind: PrintTemplateDocumentKind;
  treasuryUnitId?: string;
  bankId?: string;
  chequeBookId?: string;
  treasuryUnit?: PrintTemplateScopeReference;
  bank?: PrintTemplateScopeReference;
  chequeBook?: PrintTemplateScopeReference;
  language: PrintTemplateLanguage;
  direction: PrintTemplateDirection;
  pageProfile: PrintTemplatePageProfile;
  calibrationXmm: number;
  calibrationYmm: number;
  templateBody: Record<string, unknown>;
  templateDigest: string;
  templateVersion: number;
  state: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  createdAt: string;
}

export interface PrintTemplatePage {
  items: PrintTemplateView[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}
