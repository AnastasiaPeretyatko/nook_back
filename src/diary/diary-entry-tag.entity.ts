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
import { NoteTag } from './note-tag.entity';

// "This note is marked with this tag". No id and no times: a link is the pair of its parents, and it
// travels inside the note. The schema lives in the migration; this class only maps it.
@Entity('diary_entry_tags')
@Index('diary_entry_tags_tag_id_idx', ['tagId'])
export class DiaryEntryTag {
  @PrimaryColumn({
    name: 'entry_id',
    type: 'uuid',
    primaryKeyConstraintName: 'diary_entry_tags_pkey',
  })
  entryId: string;

  @ManyToOne(() => DiaryEntry, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'entry_id',
    foreignKeyConstraintName: 'diary_entry_tags_entry_id_fkey',
  })
  entry: DiaryEntry;

  @PrimaryColumn({
    name: 'tag_id',
    type: 'uuid',
    primaryKeyConstraintName: 'diary_entry_tags_pkey',
  })
  tagId: string;

  @ManyToOne(() => NoteTag, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tag_id',
    foreignKeyConstraintName: 'diary_entry_tags_tag_id_fkey',
  })
  tag: NoteTag;

  // The owner of the note, taken from the token.
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'diary_entry_tags_user_id_fkey',
  })
  user: User;
}
