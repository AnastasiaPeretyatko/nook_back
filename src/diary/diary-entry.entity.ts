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

// The schema itself lives in the migration (checks and triggers included); this class only maps it.
@Entity('diary_entries')
@Index('diary_entries_user_updated_idx', ['userId', 'updatedAt'])
@Check(
  'diary_entries_status_check',
  "status in ('draft', 'normal', 'archived')",
)
export class DiaryEntry {
  // Minted on the device that wrote the note; never changes.
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'diary_entries_pkey',
  })
  id: string;

  // Always taken from the token, never from the request body.
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'diary_entries_user_id_fkey',
  })
  user: User;

  @Column({ type: 'text', default: '' })
  title: string;

  // The text of the note (the app keeps it as a JSON "Delta").
  @Column({ type: 'text', default: '' })
  body: string;

  @Column({ type: 'text', nullable: true })
  coverImage: string | null;

  // A JSON list kept as text.
  @Column({ type: 'text', default: '[]' })
  images: string;

  @Column({ type: 'boolean', default: false })
  isFavorite: boolean;

  @Column({ type: 'text', default: 'normal' })
  status: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  // When the device last edited the note; the app compares it to decide whose edit is newer.
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

  // Soft deletion: the row stays (emptied by a trigger) so other devices learn of it.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
