import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'paathshala:public_route';

/**
 * Marks a route as reachable without authentication. Applied to login and
 * health only. The guard is registered globally, so a new route is authenticated
 * unless someone explicitly opts it out — the safe default.
 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
