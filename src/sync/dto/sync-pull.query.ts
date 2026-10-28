import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isInstant } from '../push-rows';

export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

@ValidatorConstraint({ name: 'isInstant' })
class IsInstant implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return isInstant(value);
  }
  defaultMessage({ property }: ValidationArguments) {
    return `${property} must be a UTC time like 2026-01-15T10:00:00.123456Z`;
  }
}

// An empty parameter (`?since=`) counts as absent.
const blankToUndefined = ({ value }: { value: unknown }) =>
  value === '' ? undefined : value;

export class SyncPullQuery {
  // The `next` of the previous answer, or empty for everything.
  @Transform(blankToUndefined)
  @IsOptional()
  @Validate(IsInstant)
  since?: string;

  // Which parts to send: tasks (always), diary, cycle. Anything else is a mistake.
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @Matches(/^(tasks|diary|cycle)(,(tasks|diary|cycle))*$/, {
    message: 'include must be a comma-separated list of tasks, diary, cycle',
  })
  include?: string;

  @Transform(({ value }) => (value === '' ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PULL_LIMIT)
  limit?: number;
}
