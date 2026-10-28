import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Task } from './task.entity';

// One day mark of one task for one user. The schema lives in the migration; this class only maps it.
@Entity('task_logs')
@Index('task_logs_user_updated_idx', ['userId', 'updatedAt'])
export class TaskLog {
  @PrimaryColumn({
    name: 'task_id',
    type: 'uuid',
    primaryKeyConstraintName: 'task_logs_pkey',
  })
  taskId: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'task_id',
    foreignKeyConstraintName: 'task_logs_task_id_fkey',
  })
  task: Task;

  // Always taken from the token, never from the request body.
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'task_logs_pkey',
  })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'task_logs_user_id_fkey',
  })
  user: User;

  // A calendar day, 'YYYY-MM-DD'.
  @PrimaryColumn({
    type: 'date',
    primaryKeyConstraintName: 'task_logs_pkey',
  })
  date: string;

  @Column({ type: 'boolean', default: false })
  completed: boolean;

  // A counter's count or a timer's seconds, depending on the task's tracking mode.
  @Column({ type: 'double precision', nullable: true })
  value: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

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
}
