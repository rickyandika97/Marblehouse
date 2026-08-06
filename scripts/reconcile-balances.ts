import { prisma } from "../src/lib/prisma";
import { runBalanceReconciliation } from "../src/server/services/balances";

runBalanceReconciliation()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.skipped ? 2 : 0;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

