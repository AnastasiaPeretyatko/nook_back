import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUserId } from '../auth/auth.guard';
import {
  CreateProjectDto,
  ProjectListQuery,
  ProjectTasksQuery,
  UpdateProjectDto,
} from './dto/project.dto';
import { projectNotFound, ProjectsService } from './projects.service';

// A malformed id should not reveal a different error from a project owned by another person.
const projectId = () =>
  new ParseUUIDPipe({ exceptionFactory: projectNotFound });

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@CurrentUserId() userId: string, @Body() dto: CreateProjectDto) {
    return this.projects.create(userId, dto);
  }

  @Get()
  list(@CurrentUserId() userId: string, @Query() query: ProjectListQuery) {
    return this.projects.list(userId, query.archived === true);
  }

  @Get(':id/tasks')
  tasks(
    @CurrentUserId() userId: string,
    @Param('id', projectId()) id: string,
    @Query() query: ProjectTasksQuery,
  ) {
    return this.projects.tasks(userId, id, query);
  }

  @Get(':id')
  detail(
    @CurrentUserId() userId: string,
    @Param('id', projectId()) id: string,
  ) {
    return this.projects.detail(userId, id);
  }

  @Patch(':id/archive')
  archive(
    @CurrentUserId() userId: string,
    @Param('id', projectId()) id: string,
  ) {
    return this.projects.archive(userId, id);
  }

  @Patch(':id/restore')
  restore(
    @CurrentUserId() userId: string,
    @Param('id', projectId()) id: string,
  ) {
    return this.projects.restore(userId, id);
  }

  @Patch(':id')
  update(
    @CurrentUserId() userId: string,
    @Param('id', projectId()) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(userId, id, dto);
  }
}
