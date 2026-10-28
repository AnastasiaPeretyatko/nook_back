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
@Entity('note_tags')
@Index('note_tags_user_updated_idx', ['userId', 'updatedAt'])
export class NoteTag {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'note_tags_pkey' })
  id: string;

  // Always taken from the token, never from the request body.
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'note_tags_user_id_fkey',
  })
  user: User;

  @Column({ type: 'text' })
  name: string;

  // A key into the app's palette (`violet`, `green`...), not the colour itself.
  @Column({ type: 'text', default: 'violet' })
  colorKey: string;

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
