import {
  Check,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { Group } from './group.entity';

// The invite code is the owner's alone to see, so it is not a column of `groups`.
@Entity('group_invites')
@Unique('group_invites_code_key', ['code'])
@Check('group_invites_code_check', "code ~ '^[0-9]{6}$'")
export class GroupInvite {
  @PrimaryColumn({
    name: 'group_id',
    type: 'uuid',
    primaryKeyConstraintName: 'group_invites_pkey',
  })
  groupId: string;

  @OneToOne(() => Group, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'group_id',
    foreignKeyConstraintName: 'group_invites_group_id_fkey',
  })
  group: Group;

  // Six digits, made by the server.
  @Column({ type: 'text' })
  code: string;
}
