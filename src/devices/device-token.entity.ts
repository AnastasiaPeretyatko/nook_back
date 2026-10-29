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

// The FCM token of one phone and the account that is signed in on it now. The schema (the check
// and the trigger included) lives in the migration; this class only maps it.
@Entity('device_tokens')
@Index('device_tokens_user_id_idx', ['userId'])
@Check('device_tokens_token_length', 'length(token) between 20 and 4096')
export class DeviceToken {
  @PrimaryColumn({
    type: 'text',
    primaryKeyConstraintName: 'device_tokens_pkey',
  })
  token: string;

  // Always taken from the access token, never from the request body.
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'device_tokens_user_id_fkey',
  })
  user: User;

  // Stamped by the set_updated_at trigger; the app never writes it.
  @Column({
    type: 'timestamptz',
    default: () => 'now()',
    insert: false,
    update: false,
  })
  updatedAt: Date;
}
