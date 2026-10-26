import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Everything needs a valid access token unless marked with this.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
