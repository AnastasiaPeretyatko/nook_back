import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

// The name of a group, 1 to 100 characters once trimmed. Blank text is too short, so "   " is
// refused rather than stored.
export class GroupNameDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  name: string;
}
