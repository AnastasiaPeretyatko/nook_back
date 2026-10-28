import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiaryEntryMood } from './diary-entry-mood.entity';
import { DiaryEntryTag } from './diary-entry-tag.entity';
import { DiaryEntry } from './diary-entry.entity';
import { NoteMood } from './note-mood.entity';
import { NoteTag } from './note-tag.entity';

// Only the tables for now; the diary joins /sync/push and /sync/pull in B3.6 and B3.7.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiaryEntry,
      NoteMood,
      NoteTag,
      DiaryEntryMood,
      DiaryEntryTag,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DiaryModule {}
