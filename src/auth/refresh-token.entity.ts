import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// A refresh token is single-use: refreshing deletes its row and inserts the next one.
// Only the SHA-256 hash is stored, never the token itself.
@Entity('refresh_tokens')
@Index('refresh_tokens_user_id_idx', ['userId'])
export class RefreshToken {
  @PrimaryColumn({
    name: 'token_hash',
    type: 'text',
    primaryKeyConstraintName: 'refresh_tokens_pkey',
  })
  tokenHash: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'refresh_tokens_user_id_fkey',
  })
  user: User;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
