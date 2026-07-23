import {
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UserRefCreateDto {
  @IsString() @MinLength(1) @MaxLength(128) subjectKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) displayName!: string;
}

export class IdentityAccountCreateDto {
  @IsString() @MinLength(1) @MaxLength(128) userId!: string;
  @IsString() @MinLength(1) @MaxLength(254) login!: string;
  @IsString() @MinLength(15) @MaxLength(128) temporaryPassword!: string;
  @IsBoolean() privileged!: boolean;
}
