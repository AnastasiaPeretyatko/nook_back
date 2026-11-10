import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Task } from '../tasks/task.entity';
import { User } from '../users/user.entity';

// The schema itself lives in the migration (checks and trigger included); this class only maps it.
@Entity('projects')
@Index('projects_user_updated_idx', ['userId', 'updatedAt'])
@Check('projects_name_check', 'length(name) between 1 and 100')
export class Project {
  // Made by the server, as with groups.
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'projects_pkey' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'projects_user_id_fkey',
  })
  user: User;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  color: string | null;

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

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @OneToMany(() => Task, (task) => task.project)
  tasks: Task[];
}
