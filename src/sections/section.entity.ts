import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import { Project } from '../projects/project.entity';
import { Task } from '../tasks/task.entity';
import { User } from '../users/user.entity';

// The migration owns the scope and ownership triggers; this maps the table for TypeORM.
@Entity('sections')
@Index('sections_user_updated_idx', ['userId', 'updatedAt'])
@Index('sections_user_project_position_idx', [
  'userId',
  'projectId',
  'position',
])
@Check(
  'sections_name_check',
  'deleted_at is not null or length(name) between 1 and 100',
)
export class Section {
  // Minted on the device, like every other personal row that travels through /sync.
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'sections_pkey' })
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'sections_user_id_fkey',
  })
  user: User;

  // Null scopes a section to the user's regular tasks; otherwise it belongs to one project.
  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId: string | null;

  @ManyToOne(() => Project, (project) => project.sections, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'project_id',
    foreignKeyConstraintName: 'sections_project_id_fkey',
  })
  project: Project | null;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'integer', default: 0 })
  position: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  // The device clock decides conflicts between local copies; the server never overwrites it.
  @Column({ type: 'timestamptz', default: () => 'now()' })
  clientUpdatedAt: Date;

  @Column({
    type: 'timestamptz',
    default: () => 'now()',
    insert: false,
    update: false,
  })
  updatedAt: Date;

  // A section deletion is retained so every device can remove it from local storage.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @OneToMany(() => Task, (task) => task.section)
  tasks: Task[];
}
