import { drizzle } from "drizzle-orm/node-postgres";
import { postgresPool } from "../../../lib/postgres";
import * as schema from "./schema";

export function getDb() {
  return drizzle(postgresPool(), { schema });
}
