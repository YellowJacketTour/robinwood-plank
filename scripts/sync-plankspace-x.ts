import { syncConnectedXAccounts } from "../integrations/plankspace-app/app/x/sync";
import { closePostgres } from "../lib/postgres";
try{const summary=await syncConnectedXAccounts({limit:Number(process.env.PLANKSPACE_X_SYNC_LIMIT||25)});console.log(`[plankspace-x-sync] accounts=${summary.accounts} imported=${summary.imported} failed=${summary.failed}`);if(summary.failed)process.exitCode=1}finally{await closePostgres()}
