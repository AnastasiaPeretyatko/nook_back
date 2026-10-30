import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// The schema itself lives in the migration (checks and triggers included); this class only maps it.
@Entity('users')
@Unique('users_email_key', ['email'])
@Unique('users_google_sub_key', ['googleSub'])
@Check('users_email_lowercase', 'email = lower(email)')
@Check(
  'users_has_credential',
  'password_hash is not null or google_sub is not null or deleted_at is not null',
)
export class User {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'users_pkey' })
  id: string;

  // Always stored lower-case (the database refuses anything else).
  @Column({ type: 'text' })
  email: string;

  // Null for an account created through Google.
  @Column({ type: 'text', nullable: true })
  passwordHash: string | null;

  // Google's stable account id; null for an email-and-password account.
  @Column({ type: 'text', nullable: true })
  googleSub: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  // Set when the account was deleted (B8.5): the row stays as an empty shell, see the migration.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
