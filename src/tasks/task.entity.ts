import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Group } from '../groups/group.entity';
import { User } from '../users/user.entity';

// The schema itself lives in the migration (checks, triggers, deferred key included); this class only maps it.
@Entity('tasks')
@Index('tasks_user_updated_idx', ['userId', 'updatedAt'])
@Index('tasks_parent_id_idx', ['parentId'])
@Index('tasks_group_updated_idx', ['groupId', 'updatedAt'])
@Check('tasks_status_check', "status in ('active', 'paused', 'archived')")
@Check(
  'tasks_repeat_type_check',
  "repeat_type is null or repeat_type in ('daily', 'weekly', 'monthly', 'custom')",
)
@Check(
  'tasks_tracking_mode_check',
  "tracking_mode in ('checkbox', 'counter', 'timer', 'value')",
)
@Check(
  'tasks_group_task_shape',
  "group_id is null or (repeat_type is null and parent_id is null and tracking_mode <> 'value')",
)
@Check(
  'tasks_assignee_needs_group',
  'assignee_id is null or group_id is not null',
)
export class Task {
  // Minted on the device that created the task; never changes.
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'tasks_pkey',
  })
  id: string;

  // Always taken from the token, never from the request body.
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'tasks_user_id_fkey',
  })
  user: User;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  // Checked at the end of the transaction, so a subtask may come before its parent.
  @ManyToOne(() => Task, {
    onDelete: 'CASCADE',
    deferrable: 'INITIALLY DEFERRED',
  })
  @JoinColumn({
    name: 'parent_id',
    foreignKeyConstraintName: 'tasks_parent_id_fkey',
  })
  parent: Task | null;

  // The group this task is shared in; null for a personal task. Fixed at creation (a trigger
  // keeps it). Only a one-off task can be in a group (see tasks_group_task_shape).
  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  groupId: string | null;

  @ManyToOne(() => Group, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'group_id',
    foreignKeyConstraintName: 'tasks_group_id_fkey',
  })
  group: Group | null;

  // Who the task is for; null means for everyone. Only inside a group, and only a member (a
  // trigger empties it otherwise). `user_id` above is the author in a group task.
  @Column({ name: 'assignee_id', type: 'uuid', nullable: true })
  assigneeId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'assignee_id',
    foreignKeyConstraintName: 'tasks_assignee_id_fkey',
  })
  assignee: User | null;

  @Column({ type: 'text', default: '' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', default: 'active' })
  status: string;

  // Null means a one-off task rather than a habit.
  @Column({ type: 'text', nullable: true })
  repeatType: string | null;

  @Column({ type: 'integer', nullable: true })
  repeatInterval: number | null;

  // Bitmask: day `d` sets bit `d - 1` (weekday 1-7, or day of month 1-31).
  @Column({ type: 'integer', nullable: true })
  repeatDaysMask: number | null;

  @Column({ type: 'text', default: 'checkbox' })
  trackingMode: string;

  @Column({ type: 'integer', nullable: true })
  targetDurationMinutes: number | null;

  @Column({ type: 'double precision', nullable: true })
  targetValue: number | null;

  // A key into the app's icon catalogue, not a font code point.
  @Column({ type: 'text', nullable: true })
  iconKey: string | null;

  // A key into the app's palette (`violet`, `green`...), not the colour itself.
  @Column({ type: 'text', nullable: true })
  colorKey: string | null;

  // Minutes from midnight; a null start means the untimed strip.
  @Column({ type: 'integer', nullable: true })
  scheduledTimeMinutes: number | null;

  @Column({ type: 'integer', nullable: true })
  endTimeMinutes: number | null;

  // A calendar day, 'YYYY-MM-DD'.
  @Column({ type: 'date', nullable: true })
  startDate: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  // When the device last edited the task; the app compares it to decide whose edit is newer.
  @Column({ type: 'timestamptz', default: () => 'now()' })
  clientUpdatedAt: Date;

  // Stamped by the set_updated_at trigger; the app never writes it.
  @Column({
    type: 'timestamptz',
    default: () => 'now()',
    insert: false,
    update: false,
  })
  updatedAt: Date;

  // Soft deletion: the row stays (emptied by a trigger) so other devices learn of it.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
