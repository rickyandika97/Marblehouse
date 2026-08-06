-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('CASH', 'EDC');

-- CreateEnum
CREATE TYPE "public"."SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "public"."MarbleTxnType" AS ENUM ('DEPOSIT', 'WITHDRAW', 'ADJUST');

-- CreateEnum
CREATE TYPE "public"."TicketTxnType" AS ENUM ('AWARD', 'REDEEM', 'ADJUST', 'VOID_RESTORE');

-- CreateEnum
CREATE TYPE "public"."StockMovementType" AS ENUM ('RECEIVE', 'REDEEM', 'TRANSFER_OUT', 'TRANSFER_IN', 'OPNAME_LOSS', 'OPNAME_GAIN', 'DAMAGE', 'MANUAL_ADJUST', 'VOID_RESTORE');

-- CreateEnum
CREATE TYPE "public"."TransferStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'EXCUSED', 'ABSENT');

-- CreateTable
CREATE TABLE "public"."Shop" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "dayStartHour" INTEGER NOT NULL DEFAULT 6,
    "lateGraceMin" INTEGER NOT NULL DEFAULT 5,
    "allowCustomAmount" BOOLEAN NOT NULL DEFAULT false,
    "allowDirectTransfer" BOOLEAN NOT NULL DEFAULT false,
    "requireClockOutPhoto" BOOLEAN NOT NULL DEFAULT false,
    "isHqPseudoShop" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "username" TEXT,
    "displayUsername" TEXT,
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "role" "public"."Role" NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "canEnterCost" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "defaultShopId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserShop" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,

    CONSTRAINT "UserShop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "impersonatedBy" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SalePreset" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Sale" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "customerId" TEXT,
    "presetId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" "public"."PaymentMethod" NOT NULL,
    "isCustomAmount" BOOLEAN NOT NULL DEFAULT false,
    "status" "public"."SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "businessDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "note" TEXT,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneRaw" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "marbleBalance" INTEGER NOT NULL DEFAULT 0,
    "ticketBalance" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MarbleLedger" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "public"."MarbleTxnType" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "saleId" TEXT,
    "businessDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarbleLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TicketLedger" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "public"."TicketTxnType" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "redemptionId" TEXT,
    "businessDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PrizeItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "imagePath" TEXT,
    "ticketCost" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrizeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ShopPrizeConfig" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "prizeItemId" TEXT NOT NULL,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopPrizeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PrizeBatch" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "prizeItemId" TEXT NOT NULL,
    "batchCode" TEXT,
    "qtyReceived" INTEGER NOT NULL,
    "qtyRemaining" INTEGER NOT NULL,
    "unitCogs" DECIMAL(14,2) NOT NULL,
    "supplier" TEXT,
    "note" TEXT,
    "isAdjustment" BOOLEAN NOT NULL DEFAULT false,
    "needsCosting" BOOLEAN NOT NULL DEFAULT false,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "sourceBatchId" TEXT,

    CONSTRAINT "PrizeBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StockMovement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "prizeItemId" TEXT NOT NULL,
    "type" "public"."StockMovementType" NOT NULL,
    "qtyDelta" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "userId" TEXT,
    "reason" TEXT,
    "businessDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StockConsumption" (
    "id" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitCogsAtConsumption" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Redemption" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalTickets" INTEGER NOT NULL,
    "totalCogs" DECIMAL(14,2) NOT NULL,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "businessDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RedemptionLine" (
    "id" TEXT NOT NULL,
    "redemptionId" TEXT NOT NULL,
    "prizeItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "ticketCostEach" INTEGER NOT NULL,
    "ticketCostTotal" INTEGER NOT NULL,
    "cogsTotal" DECIMAL(14,2) NOT NULL,
    "movementId" TEXT,

    CONSTRAINT "RedemptionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PrizeTransfer" (
    "id" TEXT NOT NULL,
    "fromShopId" TEXT NOT NULL,
    "toShopId" TEXT NOT NULL,
    "status" "public"."TransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "note" TEXT,
    "dispatchedById" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "businessDate" DATE NOT NULL,

    CONSTRAINT "PrizeTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PrizeTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "prizeItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "batchPlan" JSONB NOT NULL,

    CONSTRAINT "PrizeTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OpnameSession" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "note" TEXT,
    "isCommitted" BOOLEAN NOT NULL DEFAULT false,
    "businessDate" DATE NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "OpnameSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OpnameLine" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "prizeItemId" TEXT NOT NULL,
    "systemQty" INTEGER NOT NULL,
    "countedQty" INTEGER NOT NULL,
    "variance" INTEGER NOT NULL,
    "varianceValue" DECIMAL(14,2),
    "note" TEXT,

    CONSTRAINT "OpnameLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Expense" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "receiptPath" TEXT,
    "businessDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Shift" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TIME(0) NOT NULL,
    "endTime" TIME(0) NOT NULL,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shiftId" TEXT,
    "businessDate" DATE NOT NULL,
    "clockInAt" TIMESTAMP(3) NOT NULL,
    "clockOutAt" TIMESTAMP(3),
    "shiftStartAtCapture" TIMESTAMP(3),
    "graceMinAtCapture" INTEGER,
    "status" "public"."AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "photoPath" TEXT,
    "photoPurgedAt" TIMESTAMP(3),
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracyM" INTEGER,
    "locationDenied" BOOLEAN NOT NULL DEFAULT false,
    "clockOutPhotoPath" TEXT,
    "note" TEXT,
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "role" "public"."Role",
    "shopId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IdempotencyKey" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "responseJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "public"."BackupRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT,
    "filePath" TEXT,
    "checksum" TEXT,
    "errorText" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_code_key" ON "public"."Shop"("code");

-- CreateIndex
CREATE INDEX "Shop_isActive_idx" ON "public"."Shop"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "public"."user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "public"."user"("username");

-- CreateIndex
CREATE INDEX "user_role_banned_idx" ON "public"."user"("role", "banned");

-- CreateIndex
CREATE INDEX "UserShop_shopId_idx" ON "public"."UserShop"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "UserShop_userId_shopId_key" ON "public"."UserShop"("userId", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "public"."session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "public"."session"("userId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "public"."session"("expiresAt");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "public"."account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "public"."verification"("identifier");

-- CreateIndex
CREATE INDEX "WorkSession_shopId_businessDate_idx" ON "public"."WorkSession"("shopId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSession_userId_businessDate_key" ON "public"."WorkSession"("userId", "businessDate");

-- CreateIndex
CREATE INDEX "SalePreset_shopId_isActive_sortOrder_idx" ON "public"."SalePreset"("shopId", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "Sale_shopId_businessDate_idx" ON "public"."Sale"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "Sale_customerId_occurredAt_idx" ON "public"."Sale"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "Sale_recordedById_businessDate_idx" ON "public"."Sale"("recordedById", "businessDate");

-- CreateIndex
CREATE INDEX "Sale_businessDate_idx" ON "public"."Sale"("businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phoneNormalized_key" ON "public"."Customer"("phoneNormalized");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "public"."Customer"("name");

-- CreateIndex
CREATE INDEX "Customer_lastSeenAt_idx" ON "public"."Customer"("lastSeenAt");

-- CreateIndex
CREATE INDEX "MarbleLedger_customerId_occurredAt_idx" ON "public"."MarbleLedger"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "MarbleLedger_shopId_businessDate_idx" ON "public"."MarbleLedger"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "TicketLedger_customerId_occurredAt_idx" ON "public"."TicketLedger"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "TicketLedger_shopId_businessDate_idx" ON "public"."TicketLedger"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "TicketLedger_userId_businessDate_idx" ON "public"."TicketLedger"("userId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "PrizeItem_sku_key" ON "public"."PrizeItem"("sku");

-- CreateIndex
CREATE INDEX "PrizeItem_isActive_name_idx" ON "public"."PrizeItem"("isActive", "name");

-- CreateIndex
CREATE INDEX "ShopPrizeConfig_shopId_isActive_idx" ON "public"."ShopPrizeConfig"("shopId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ShopPrizeConfig_shopId_prizeItemId_key" ON "public"."ShopPrizeConfig"("shopId", "prizeItemId");

-- CreateIndex
CREATE INDEX "PrizeBatch_shopId_prizeItemId_receivedAt_idx" ON "public"."PrizeBatch"("shopId", "prizeItemId", "receivedAt");

-- CreateIndex
CREATE INDEX "PrizeBatch_shopId_prizeItemId_qtyRemaining_idx" ON "public"."PrizeBatch"("shopId", "prizeItemId", "qtyRemaining");

-- CreateIndex
CREATE INDEX "PrizeBatch_needsCosting_idx" ON "public"."PrizeBatch"("needsCosting");

-- CreateIndex
CREATE INDEX "StockMovement_shopId_prizeItemId_occurredAt_idx" ON "public"."StockMovement"("shopId", "prizeItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_businessDate_type_idx" ON "public"."StockMovement"("businessDate", "type");

-- CreateIndex
CREATE INDEX "StockConsumption_movementId_idx" ON "public"."StockConsumption"("movementId");

-- CreateIndex
CREATE INDEX "StockConsumption_batchId_idx" ON "public"."StockConsumption"("batchId");

-- CreateIndex
CREATE INDEX "Redemption_shopId_businessDate_idx" ON "public"."Redemption"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "Redemption_customerId_occurredAt_idx" ON "public"."Redemption"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "RedemptionLine_redemptionId_idx" ON "public"."RedemptionLine"("redemptionId");

-- CreateIndex
CREATE INDEX "RedemptionLine_prizeItemId_idx" ON "public"."RedemptionLine"("prizeItemId");

-- CreateIndex
CREATE INDEX "PrizeTransfer_fromShopId_status_idx" ON "public"."PrizeTransfer"("fromShopId", "status");

-- CreateIndex
CREATE INDEX "PrizeTransfer_toShopId_status_idx" ON "public"."PrizeTransfer"("toShopId", "status");

-- CreateIndex
CREATE INDEX "PrizeTransferLine_transferId_idx" ON "public"."PrizeTransferLine"("transferId");

-- CreateIndex
CREATE INDEX "OpnameSession_shopId_businessDate_idx" ON "public"."OpnameSession"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "OpnameLine_sessionId_idx" ON "public"."OpnameLine"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "public"."ExpenseCategory"("name");

-- CreateIndex
CREATE INDEX "Expense_shopId_businessDate_idx" ON "public"."Expense"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "Expense_categoryId_businessDate_idx" ON "public"."Expense"("categoryId", "businessDate");

-- CreateIndex
CREATE INDEX "Shift_shopId_isActive_idx" ON "public"."Shift"("shopId", "isActive");

-- CreateIndex
CREATE INDEX "Attendance_shopId_businessDate_idx" ON "public"."Attendance"("shopId", "businessDate");

-- CreateIndex
CREATE INDEX "Attendance_businessDate_isLate_idx" ON "public"."Attendance"("businessDate", "isLate");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_businessDate_key" ON "public"."Attendance"("userId", "businessDate");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "public"."AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_occurredAt_idx" ON "public"."AuditLog"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "public"."AuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "public"."IdempotencyKey"("createdAt");

-- CreateIndex
CREATE INDEX "BackupRun_startedAt_idx" ON "public"."BackupRun"("startedAt");

-- AddForeignKey
ALTER TABLE "public"."user" ADD CONSTRAINT "user_defaultShopId_fkey" FOREIGN KEY ("defaultShopId") REFERENCES "public"."Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserShop" ADD CONSTRAINT "UserShop_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserShop" ADD CONSTRAINT "UserShop_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkSession" ADD CONSTRAINT "WorkSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkSession" ADD CONSTRAINT "WorkSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SalePreset" ADD CONSTRAINT "SalePreset_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sale" ADD CONSTRAINT "Sale_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "public"."SalePreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarbleLedger" ADD CONSTRAINT "MarbleLedger_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarbleLedger" ADD CONSTRAINT "MarbleLedger_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MarbleLedger" ADD CONSTRAINT "MarbleLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketLedger" ADD CONSTRAINT "TicketLedger_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketLedger" ADD CONSTRAINT "TicketLedger_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketLedger" ADD CONSTRAINT "TicketLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ShopPrizeConfig" ADD CONSTRAINT "ShopPrizeConfig_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ShopPrizeConfig" ADD CONSTRAINT "ShopPrizeConfig_prizeItemId_fkey" FOREIGN KEY ("prizeItemId") REFERENCES "public"."PrizeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrizeBatch" ADD CONSTRAINT "PrizeBatch_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrizeBatch" ADD CONSTRAINT "PrizeBatch_prizeItemId_fkey" FOREIGN KEY ("prizeItemId") REFERENCES "public"."PrizeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockMovement" ADD CONSTRAINT "StockMovement_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockMovement" ADD CONSTRAINT "StockMovement_prizeItemId_fkey" FOREIGN KEY ("prizeItemId") REFERENCES "public"."PrizeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockConsumption" ADD CONSTRAINT "StockConsumption_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "public"."StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockConsumption" ADD CONSTRAINT "StockConsumption_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."PrizeBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Redemption" ADD CONSTRAINT "Redemption_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Redemption" ADD CONSTRAINT "Redemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Redemption" ADD CONSTRAINT "Redemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RedemptionLine" ADD CONSTRAINT "RedemptionLine_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "public"."Redemption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RedemptionLine" ADD CONSTRAINT "RedemptionLine_prizeItemId_fkey" FOREIGN KEY ("prizeItemId") REFERENCES "public"."PrizeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrizeTransfer" ADD CONSTRAINT "PrizeTransfer_fromShopId_fkey" FOREIGN KEY ("fromShopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrizeTransfer" ADD CONSTRAINT "PrizeTransfer_toShopId_fkey" FOREIGN KEY ("toShopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrizeTransferLine" ADD CONSTRAINT "PrizeTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "public"."PrizeTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PrizeTransferLine" ADD CONSTRAINT "PrizeTransferLine_prizeItemId_fkey" FOREIGN KEY ("prizeItemId") REFERENCES "public"."PrizeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OpnameSession" ADD CONSTRAINT "OpnameSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OpnameLine" ADD CONSTRAINT "OpnameLine_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."OpnameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OpnameLine" ADD CONSTRAINT "OpnameLine_prizeItemId_fkey" FOREIGN KEY ("prizeItemId") REFERENCES "public"."PrizeItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Shift" ADD CONSTRAINT "Shift_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attendance" ADD CONSTRAINT "Attendance_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "public"."Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attendance" ADD CONSTRAINT "Attendance_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "public"."Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
