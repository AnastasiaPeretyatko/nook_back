import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUserId } from '../auth/auth.guard';
import { DeviceId } from '../realtime/device-id';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUserId() userId: string) {
    return this.users.getById(userId);
  }

  @Put('profile')
  updateProfile(
    @CurrentUserId() userId: string,
    @Body() dto: UpdateProfileDto,
    @DeviceId() deviceId?: string,
  ) {
    return this.users.updateProfile(userId, dto, deviceId);
  }
}
