import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Group } from './group.entity';

// The owner has a row too (role 'owner'). A member is never deleted, only stamped `deletedAt`.
@Entity('group_members')
@Index('group_members_user_idx', ['userId'])
@Check('group_members_role_check', "role in ('owner', 'member')")
export class GroupMember {
  @PrimaryColumn({
    name: 'group_id',
    type: 'uuid',
    primaryKeyConstraintName: 'group_members_pkey',
  })
  groupId: string;

  @ManyToOne(() => Group, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'group_id',
    foreignKeyConstraintName: 'group_members_group_id_fkey',
  })
  group: Group;

  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'group_members_pkey',
  })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'group_members_user_id_fkey',
  })
  user: User;

  @Column({ type: 'text', default: 'member' })
  role: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  joinedAt: Date;

  // Stamped by the set_updated_at trigger.
  @Column({
    type: 'timestamptz',
    default: () => 'now()',
    insert: false,
    update: false,
  })
  updatedAt: Date;

  // Left, removed or the group was deleted: the phone learns it from the group's absence in /sync.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
