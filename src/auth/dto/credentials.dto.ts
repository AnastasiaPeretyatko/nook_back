import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { withCode } from '../../common/validation.pipe';

// Emails are compared and stored in lower case; the database refuses anything else.
const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @Transform(normalizeEmail)
  @IsEmail({}, withCode('invalid_email', 'Invalid email address'))
  @MaxLength(254, withCode('invalid_email', 'Invalid email address'))
  email: string;

  @IsString(withCode('weak_password', 'Password must be 8 to 128 characters'))
  @MinLength(
    8,
    withCode('weak_password', 'Password must be 8 to 128 characters'),
  )
  @MaxLength(
    128,
    withCode('weak_password', 'Password must be 8 to 128 characters'),
  )
  password: string;
}

// Login judges nothing about the shape: a wrong email or password is simply
// `invalid_credentials`, whatever it looks like.
export class LoginDto {
  @Transform(normalizeEmail)
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
