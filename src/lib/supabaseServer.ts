export function serverReadKey(primaryKey: string, serviceRoleKey?: string) {
  return serviceRoleKey || primaryKey;
}
