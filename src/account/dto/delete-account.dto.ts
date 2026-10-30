import { IsOptional, IsString, MaxLength } from 'class-validator';

// How the person proves it is them: the password (an account with one) or a fresh Google ID
// token (an account made with Google). Exactly one of the two; the service checks that.
export class DeleteAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  idToken?: string;
}
