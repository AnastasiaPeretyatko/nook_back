// Why a row of a push was not written. The app turns these codes into Russian text.
export type RejectReason =
  | 'invalid_row'
  | 'id_taken'
  | 'unknown_parent'
  | 'parent_cycle'
  | 'unknown_task'
  | 'unknown_label'
  | 'unknown_group'
  | 'not_allowed'
  | 'unsupported_table';

export interface Rejection {
  table: string;
  // Null when the row had no usable id.
  id: string | null;
  reason: RejectReason;
}
