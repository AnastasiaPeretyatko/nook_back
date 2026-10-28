import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// The schema itself lives in the migration (checks, triggers included); this class only maps it.
@Entity('groups')
@Check('groups_name_check', 'length(name) between 1 and 100')
export class Group {
  // Made by the server.
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'groups_pkey' })
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'owner_id',
    foreignKeyConstraintName: 'groups_owner_id_fkey',
  })
  owner: User;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  // Stamped by the set_updated_at trigger.
  @Column({
    type: 'timestamptz',
    default: () => 'now()',
    insert: false,
    update: false,
  })
  updatedAt: Date;

  // Soft deletion: the row stays so that the members' phones learn the group is gone.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
