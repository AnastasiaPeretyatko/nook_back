import { Body, Controller, Delete, HttpCode, Put } from '@nestjs/common';
import { CurrentUserId } from '../auth/auth.guard';
import { DeviceTokenDto } from './dto/device-token.dto';
import { DevicesService } from './devices.service';

// Closed by default (the global guard); the owner is always the token's user, never the body.
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Put()
  @HttpCode(204)
  async register(@CurrentUserId() userId: string, @Body() dto: DeviceTokenDto) {
    await this.devices.register(userId, dto.token);
  }

  @Delete()
  @HttpCode(204)
  async unregister(
    @CurrentUserId() userId: string,
    @Body() dto: DeviceTokenDto,
  ) {
    await this.devices.unregister(userId, dto.token);
  }
}
