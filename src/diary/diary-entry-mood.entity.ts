import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { DiaryEntry } from './diary-entry.entity';
import { NoteMood } from './note-mood.entity';

// "This note is marked with this mood". No id and no times: a link is the pair of its parents, and it
// travels inside the note. The schema lives in the migration; this class only maps it.
@Entity('diary_entry_moods')
@Index('diary_entry_moods_mood_id_idx', ['moodId'])
export class DiaryEntryMood {
  @PrimaryColumn({
    name: 'entry_id',
    type: 'uuid',
    primaryKeyConstraintName: 'diary_entry_moods_pkey',
  })
  entryId: string;

  @ManyToOne(() => DiaryEntry, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'entry_id',
    foreignKeyConstraintName: 'diary_entry_moods_entry_id_fkey',
  })
  entry: DiaryEntry;

  @PrimaryColumn({
    name: 'mood_id',
    type: 'uuid',
    primaryKeyConstraintName: 'diary_entry_moods_pkey',
  })
  moodId: string;

  @ManyToOne(() => NoteMood, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'mood_id',
    foreignKeyConstraintName: 'diary_entry_moods_mood_id_fkey',
  })
  mood: NoteMood;

  // The owner of the note, taken from the token.
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'diary_entry_moods_user_id_fkey',
  })
  user: User;
}
