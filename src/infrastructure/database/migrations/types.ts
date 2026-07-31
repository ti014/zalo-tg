export interface Migration {
  version: number;
  name: string;
  sql: string;
}
