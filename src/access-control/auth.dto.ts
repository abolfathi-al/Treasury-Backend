import {
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  login!: string;

  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  deviceLabel?: string;
}

export class TotpProofDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  challengeId!: string;

  @IsString()
  @Matches(/^[0-9]{6}$/u)
  code!: string;
}

export class PasswordRecoveryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  login!: string;

  @IsString()
  @MinLength(15)
  @MaxLength(128)
  newPassword!: string;

  @IsString()
  @Length(1, 256)
  recoveryCode!: string;

  @IsString()
  @Matches(/^[0-9]{6}$/u)
  totpCode!: string;
}
