import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// A wrong invite code guessed by an account; ten in an hour block the account. In the database,
// not in memory, because the server restarts.
@Entity('group_join_failures')
@Index('group_join_failures_user_at_idx', ['userId', 'at'])
export class GroupJoinFailure {
  @PrimaryGeneratedColumn('identity', {
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'group_join_failures_pkey',
  })
  id: number;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'group_join_failures_user_id_fkey',
  })
  user: User;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;
}
