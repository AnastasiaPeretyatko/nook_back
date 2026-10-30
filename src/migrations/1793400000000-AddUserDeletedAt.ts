import { MigrationInterface, QueryRunner } from 'typeorm';

// Deleting an account (B8.5) keeps the row of the user as an empty shell instead of removing it.
// Other people's phones hold tasks and marks that this person wrote in shared groups; erasing the
// row would cascade them away from the server without a trace, and those phones would keep them
// forever. The shell has no password, no Google id, no profile and a made-up email; everything
// personal is erased by the code. `deleted_at` is what tells a shell from a live account, and a
// shell is the only account allowed to have no way to sign in.
export class AddUserDeletedAt1793400000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table users add column deleted_at timestamptz`,
    );
    await queryRunner.query(
      `alter table users drop constraint users_has_credential`,
    );
    await queryRunner.query(`
      alter table users add constraint users_has_credential
        check (password_hash is not null or google_sub is not null or deleted_at is not null)
    `);
  }

  // Fails if a deleted account exists: it has no way to sign in, which the old rule forbids.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `alter table users drop constraint users_has_credential`,
    );
    await queryRunner.query(`
      alter table users add constraint users_has_credential
        check (password_hash is not null or google_sub is not null)
    `);
    await queryRunner.query(`alter table users drop column deleted_at`);
  }
}
