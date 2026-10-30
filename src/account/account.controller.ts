import { Body, Controller, Delete, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUserId } from '../auth/auth.guard';
import { DeviceId } from '../realtime/device-id';
import { AccountService } from './account.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

@Controller('me')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  // Strict like the login routes: with a stolen access token this is a place to guess the password.
  @Throttle({
    burst: { ttl: 60_000, limit: 5 },
    sustained: { ttl: 3_600_000, limit: 20 },
  })
  @Delete()
  @HttpCode(204)
  async delete(
    @CurrentUserId() userId: string,
    @Body() dto: DeleteAccountDto,
    @DeviceId() deviceId?: string,
  ) {
    await this.account.delete(userId, dto, deviceId);
  }
}
