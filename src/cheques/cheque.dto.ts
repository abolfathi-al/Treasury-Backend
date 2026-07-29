import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const trim = ({ value }: { value: unknown }): unknown => (
  typeof value === 'string' ? value.trim() : value
);

export class ChequeBookCreateDto {
  @IsUUID()
  bankAccountId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  series!: string;

  @IsInt()
  @Min(1)
  firstLeaf!: number;

  @IsInt()
  @Min(1)
  lastLeaf!: number;

  @IsDateString({ strict: true })
  @Matches(DATE)
  receivedDate!: string;

  @IsOptional()
  @IsUUID()
  custodianUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export enum ChequeLeafCommand {
  VOID = 'VOID',
  REPORT_LOST = 'REPORT_LOST',
}

export class ChequeLeafTransitionDto {
  @IsEnum(ChequeLeafCommand)
  command!: ChequeLeafCommand;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export interface ChequeSemanticRef {
  id: string;
  label: string;
}

export type ChequeLeafState =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'CONSUMED'
  | 'VOID'
  | 'LOST'
  | 'STOPPED';

export interface ChequeLeafSummary {
  id: string;
  chequeBookId: string;
  series: string;
  leafNumber: number;
  label: string;
  state: ChequeLeafState;
  version: number;
}

export interface ChequeBookView {
  id: string;
  organizationId: string;
  bankAccountId: string;
  bankAccount: ChequeSemanticRef;
  series: string;
  firstLeaf: number;
  lastLeaf: number;
  leafCount: number;
  receivedDate: string;
  custodianUserId?: string;
  custodian?: ChequeSemanticRef;
  notes?: string;
  state: 'ACTIVE';
  version: number;
  leaves: ChequeLeafSummary[];
  createdAt: string;
  updatedAt: string;
}
