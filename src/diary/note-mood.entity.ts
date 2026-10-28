import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// The schema itself lives in the migration; this class only maps it.
@Entity('note_moods')
@Index('note_moods_user_updated_idx', ['userId', 'updatedAt'])
export class NoteMood {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'note_moods_pkey' })
  id: string;

  // Empty for the eight starter moods: they belong to the application and nobody can change
  // them (the database refuses). Otherwise taken from the token, never from the request body.
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'note_moods_user_id_fkey',
  })
  user: User | null;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  emoji: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

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

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
