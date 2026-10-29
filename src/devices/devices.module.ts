import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceToken } from './device-token.entity';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceToken])],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [TypeOrmModule],
})
export class DevicesModule {}
