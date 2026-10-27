-- 补齐 migrations 与 schema.prisma 之间的差距（生产库历来用 db push 更新，迁移文件一直落后）。
-- 全部语句幂等：两台生产库已经通过 db push / 手工 SQL 有了这些列、表、索引和外键，
-- 在它们上面重放本迁移不会报错，也不会改变任何东西。
-- 只用 db push 建的库（没有 _prisma_migrations 记录）：先对本迁移之前的 9 个迁移逐个
-- `npx prisma migrate resolve --applied <name>`，再 `npx prisma migrate deploy`。

-- AlterTable
ALTER TABLE "LPT_english"."QuizRecord" ADD COLUMN IF NOT EXISTS "isCorrect" BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS "timeSpentMs" INTEGER,
ADD COLUMN IF NOT EXISTS "userInput" TEXT;

-- AlterTable
ALTER TABLE "LPT_english"."StudyPlan" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."User" ADD COLUMN IF NOT EXISTS "avatar" TEXT,
ADD COLUMN IF NOT EXISTS "dailyGoal" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "nickname" TEXT,
ADD COLUMN IF NOT EXISTS "streakDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."UserLibrary" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "starCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'USER',
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."WordVisit" ADD COLUMN IF NOT EXISTS "audioPlays" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "dwellTimeMs" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "source" TEXT;

-- AlterTable
ALTER TABLE "LPT_english"."chat_messages" ADD COLUMN IF NOT EXISTS "tokensUsed" INTEGER;

-- AlterTable
ALTER TABLE "LPT_english"."chat_sessions" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."word_chinese" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."word_ecdict" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."word_markdown" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."word_notes" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "likeCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "LPT_english"."words" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE IF NOT EXISTS "LPT_english"."CheckinLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "wordsCount" INTEGER NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckinLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LPT_english"."UserWordState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'UNFAMILIAR',
    "memoryStrength" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "stability" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "repetitionCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveRight" INTEGER NOT NULL DEFAULT 0,
    "wrongCount" INTEGER NOT NULL DEFAULT 0,
    "lastTestedAt" TIMESTAMP(3),
    "nextReviewAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserWordState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LPT_english"."AmbientArticle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleZh" TEXT,
    "level" TEXT NOT NULL DEFAULT 'B1',
    "season" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "userId" TEXT,
    "paragraphs" JSONB NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmbientArticle_pkey" PRIMARY KEY ("id")
);

-- AmbientArticle.userId 比这张表晚加（5c641ba91），表已存在的库可能还没有这一列
ALTER TABLE "LPT_english"."AmbientArticle" ADD COLUMN IF NOT EXISTS "userId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CheckinLog_userId_idx" ON "LPT_english"."CheckinLog"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CheckinLog_userId_date_key" ON "LPT_english"."CheckinLog"("userId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserWordState_userId_nextReviewAt_idx" ON "LPT_english"."UserWordState"("userId", "nextReviewAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserWordState_userId_stage_idx" ON "LPT_english"."UserWordState"("userId", "stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserWordState_word_idx" ON "LPT_english"."UserWordState"("word");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UserWordState_userId_word_key" ON "LPT_english"."UserWordState"("userId", "word");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AmbientArticle_level_idx" ON "LPT_english"."AmbientArticle"("level");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AmbientArticle_userId_idx" ON "LPT_english"."AmbientArticle"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "QuizRecord_userId_timestamp_idx" ON "LPT_english"."QuizRecord"("userId", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WordVisit_userId_timestamp_idx" ON "LPT_english"."WordVisit"("userId", "timestamp");

-- 外键：旧迁移建的是 ON DELETE RESTRICT，schema 要的是 CASCADE；新表的外键还不存在。
-- 统一先 DROP IF EXISTS 再 ADD，重放时结果相同。
-- AddForeignKey
ALTER TABLE "LPT_english"."QuizRecord" DROP CONSTRAINT IF EXISTS "QuizRecord_userId_fkey";
ALTER TABLE "LPT_english"."QuizRecord" ADD CONSTRAINT "QuizRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."StudyPlan" DROP CONSTRAINT IF EXISTS "StudyPlan_userId_fkey";
ALTER TABLE "LPT_english"."StudyPlan" ADD CONSTRAINT "StudyPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."WordVisit" DROP CONSTRAINT IF EXISTS "WordVisit_userId_fkey";
ALTER TABLE "LPT_english"."WordVisit" ADD CONSTRAINT "WordVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."chat_sessions" DROP CONSTRAINT IF EXISTS "chat_sessions_userId_fkey";
ALTER TABLE "LPT_english"."chat_sessions" ADD CONSTRAINT "chat_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."note_interactions" DROP CONSTRAINT IF EXISTS "note_interactions_userId_fkey";
ALTER TABLE "LPT_english"."note_interactions" ADD CONSTRAINT "note_interactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."word_notes" DROP CONSTRAINT IF EXISTS "word_notes_userId_fkey";
ALTER TABLE "LPT_english"."word_notes" ADD CONSTRAINT "word_notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."CheckinLog" DROP CONSTRAINT IF EXISTS "CheckinLog_userId_fkey";
ALTER TABLE "LPT_english"."CheckinLog" ADD CONSTRAINT "CheckinLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."UserWordState" DROP CONSTRAINT IF EXISTS "UserWordState_userId_fkey";
ALTER TABLE "LPT_english"."UserWordState" ADD CONSTRAINT "UserWordState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LPT_english"."AmbientArticle" DROP CONSTRAINT IF EXISTS "AmbientArticle_userId_fkey";
ALTER TABLE "LPT_english"."AmbientArticle" ADD CONSTRAINT "AmbientArticle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LPT_english"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- lower(word) 表达式索引：src/lib/data.ts 的搜索 / 查词都是 WHERE lower(word) ...，没有它们会全表扫 77 万行。
-- Prisma 不认识表达式索引（schema.prisma 里写不出来，db push 也不会删），只能放在这里；两台生产库已手工建过。
CREATE INDEX IF NOT EXISTS words_lower_word_idx ON "LPT_english"."words" (lower(word));
CREATE INDEX IF NOT EXISTS words_lower_word_pattern_idx ON "LPT_english"."words" (lower(word) text_pattern_ops);
CREATE INDEX IF NOT EXISTS word_markdown_lower_word_idx ON "LPT_english"."word_markdown" (lower(word));
