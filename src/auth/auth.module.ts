import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { RefreshToken } from './refresh-token.entity';

@Module({
  imports: [UsersModule, TypeOrmModule.forFeature([RefreshToken])],
})
export class AuthModule {}
