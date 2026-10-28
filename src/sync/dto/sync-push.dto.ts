import { ArrayMaxSize, IsArray, IsOptional } from 'class-validator';
import { withCode } from '../../common/validation.pipe';

export const MAX_ROWS_PER_PUSH = 500;

const tooMany = withCode(
  'batch_too_large',
  `At most ${MAX_ROWS_PER_PUSH} rows per list in one push`,
);

// Only the shape of the lists is checked here. The rows inside are left alone on purpose
// (see push-rows.ts): a bad row must be reported in `rejected`, not fail the whole request.
// Decorator order matters: the bottom one is checked first, so IsArray comes before the size.
export class SyncPushDto {
  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  tasks?: unknown[];

  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  logs?: unknown[];

  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  deleted?: unknown[];

  // Not supported yet (diary B3, cycle B4). Listed so that they are refused in `rejected`
  // instead of being dropped without a word: the app would think they were saved.
  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  moods?: unknown[];

  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  tags?: unknown[];

  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  entries?: unknown[];

  @IsOptional()
  @ArrayMaxSize(MAX_ROWS_PER_PUSH, tooMany)
  @IsArray()
  cycle_days?: unknown[];
}
