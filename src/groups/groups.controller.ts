import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUserId } from '../auth/auth.guard';
import { GroupNameDto } from './dto/group-name.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { groupNotFound, GroupsService } from './groups.service';

// A malformed id is a group that does not exist, not a validation error: the same `404` as any
// other group the caller has no business with.
const groupId = () => new ParseUUIDPipe({ exceptionFactory: groupNotFound });

// Closed by default (the global guard); the caller is always the token's user.
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post()
  create(@CurrentUserId() userId: string, @Body() dto: GroupNameDto) {
    return this.groups.create(userId, dto.name);
  }

  @Post('join')
  @HttpCode(200)
  join(@CurrentUserId() userId: string, @Body() dto: JoinGroupDto) {
    return this.groups.join(userId, dto.code);
  }

  @Post(':id/leave')
  @HttpCode(204)
  async leave(
    @CurrentUserId() userId: string,
    @Param('id', groupId()) id: string,
  ) {
    await this.groups.leave(userId, id);
  }

  @Delete(':id/members/:memberId')
  @HttpCode(204)
  async removeMember(
    @CurrentUserId() userId: string,
    @Param('id', groupId()) id: string,
    @Param('memberId', groupId()) memberId: string,
  ) {
    await this.groups.removeMember(userId, id, memberId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', groupId()) id: string,
  ) {
    await this.groups.remove(userId, id);
  }

  @Patch(':id')
  @HttpCode(204)
  async rename(
    @CurrentUserId() userId: string,
    @Param('id', groupId()) id: string,
    @Body() dto: GroupNameDto,
  ) {
    await this.groups.rename(userId, id, dto.name);
  }

  @Get(':id/invite')
  invite(@CurrentUserId() userId: string, @Param('id', groupId()) id: string) {
    return this.groups.invite(userId, id);
  }

  @Post(':id/invite/regenerate')
  @HttpCode(200)
  regenerateInvite(
    @CurrentUserId() userId: string,
    @Param('id', groupId()) id: string,
  ) {
    return this.groups.regenerateInvite(userId, id);
  }
}
