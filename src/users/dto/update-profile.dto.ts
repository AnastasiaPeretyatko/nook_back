import { Transform } from 'class-transformer';
import { IsString, IsUrl, MaxLength, ValidateIf } from 'class-validator';

// Both fields must be present (PUT replaces the profile); `null` clears one.
// Blank text counts as cleared, so "" and "   " never end up stored.
const blankToNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  return value.trim() || null;
};

export class UpdateProfileDto {
  @Transform(blankToNull)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  displayName: string | null;

  // Other members' phones load this address, so only https is accepted.
  @Transform(blankToNull)
  @ValidateIf((_, value) => value !== null)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  avatarUrl: string | null;
}
