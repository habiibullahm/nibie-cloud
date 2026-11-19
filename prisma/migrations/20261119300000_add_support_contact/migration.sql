-- Support contacts for the dashboard's Support page, edited from the admin panel. A single row (id = 1).
CREATE TABLE "SupportContact" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "whatsapp" TEXT,
    "email" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SupportContact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SupportContact_single_row" CHECK ("id" = 1)
);

-- Row level security, like every other table: the backend connects as the owner (which bypasses RLS) and no policy is
-- defined, so Supabase's anon and authenticated roles see nothing through the Data API. The public API serves the row.
ALTER TABLE "SupportContact" ENABLE ROW LEVEL SECURITY;
