import { MigrationInterface, QueryRunner } from 'typeorm';

// Whether a day belongs to menstruation is independent from its intensity.
// Existing rows used a positive flow as the period marker, so preserve that
// meaning during the migration while allowing new period days with flow = 0.
export class AddCycleDayIsPeriod1793500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table cycle_days
        add column is_period boolean not null default false
    `);
    await queryRunner.query(`
      update cycle_days set is_period = true where flow > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The old schema can only represent a period through a positive flow.
    // Use the old middle value for period days whose intensity was unspecified.
    await queryRunner.query(`
      update cycle_days set flow = 3 where is_period and flow = 0
    `);
    await queryRunner.query(`alter table cycle_days drop column is_period`);
  }
}
