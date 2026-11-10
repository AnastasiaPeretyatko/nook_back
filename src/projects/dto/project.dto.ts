import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_PULL_LIMIT,
  MAX_PULL_LIMIT,
} from '../../sync/dto/sync-pull.query';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateProjectDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  color?: string | null;
}

export class UpdateProjectDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  color?: string | null;
}

const optionalBoolean = ({ value }: { value: unknown }) => {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class ProjectListQuery {
  @Transform(optionalBoolean)
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class ProjectTasksQuery {
  @Transform(optionalBoolean)
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @Transform(({ value }) => (value === '' ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PULL_LIMIT)
  limit?: number;

  @Transform(({ value }) => (value === '' ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

export const defaultProjectTasksLimit = DEFAULT_PULL_LIMIT;
