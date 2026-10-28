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

// One day of the cycle calendar. The schema (checks and trigger included) lives in the
// migration; this class only maps it. The options are indexes into the app's lists.
@Entity('cycle_days')
@Index('cycle_days_user_updated_idx', ['userId', 'updatedAt'])
@Check('cycle_days_flow_check', 'flow between 0 and 4')
@Check('cycle_days_mood_check', 'mood between 0 and 5')
@Check(
  'cycle_days_symptoms_check',
  'symptoms <@ array[0, 1, 2, 3, 4, 5, 6, 7, 8]::smallint[]',
)
@Check('cycle_days_discharge_check', 'discharge between 0 and 6')
@Check('cycle_days_sex_check', 'sex between 0 and 2')
export class CycleDay {
  // Always taken from the token, never from the request body.
  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'cycle_days_pkey',
  })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'cycle_days_user_id_fkey',
  })
  user: User;

  // A calendar day, 'YYYY-MM-DD'.
  @PrimaryColumn({
    type: 'date',
    primaryKeyConstraintName: 'cycle_days_pkey',
  })
  date: string;

  @Column({ type: 'smallint', default: 0 })
  flow: number;

  @Column({ type: 'smallint', nullable: true })
  mood: number | null;

  @Column({ type: 'smallint', array: true, default: () => "'{}'" })
  symptoms: number[];

  @Column({ type: 'smallint', nullable: true })
  discharge: number | null;

  @Column({ type: 'smallint', nullable: true })
  sex: number | null;

  @Column({ type: 'boolean', default: false })
  pill: boolean;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  // When the device last edited the day; the app compares it to decide whose edit is newer.
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
}
