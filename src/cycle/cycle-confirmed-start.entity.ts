import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// A user-confirmed period boundary. The date itself is the natural key: it is deliberately a
// PostgreSQL DATE, never a JavaScript moment, so a device timezone cannot move it a day.
@Entity('cycle_confirmed_starts')
@Index('cycle_confirmed_starts_user_updated_idx', ['userId', 'updatedAt'])
export class CycleConfirmedStart {
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'cycle_confirmed_starts_pkey',
  })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'cycle_confirmed_starts_user_id_fkey',
  })
  user: User;

  @PrimaryColumn({
    type: 'date',
    primaryKeyConstraintName: 'cycle_confirmed_starts_pkey',
  })
  date: string;

  @Column({
    type: 'timestamptz',
    default: () => 'now()',
    insert: false,
    update: false,
  })
  updatedAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
