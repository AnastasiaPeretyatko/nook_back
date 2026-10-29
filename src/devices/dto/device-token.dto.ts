import { IsString, Length, Matches } from 'class-validator';
import { withCode } from '../../common/validation.pipe';

// The FCM token of a phone. Every way of being wrong is the same `bad_token`. A token is a run of
// visible ASCII with no spaces; that also keeps out `\0`, which a Postgres text column cannot hold
// (it would be a 500, not a 400). The length is the same as the table's check.
export class DeviceTokenDto {
  @IsString(withCode('bad_token', 'token must be a string'))
  @Length(
    20,
    4096,
    withCode('bad_token', 'token must be 20 to 4096 characters'),
  )
  @Matches(
    /^[\x21-\x7e]+$/,
    withCode('bad_token', 'token must be visible characters without spaces'),
  )
  token: string;
}
