import { IsString, MaxLength } from 'class-validator';

// What the person typed, as it is: spaces, dashes and the like are cleaned off by the service.
// The cap only keeps absurdly long text out; anything shorter that is not a code is a wrong code.
export class JoinGroupDto {
  @IsString()
  @MaxLength(64)
  code: string;
}
