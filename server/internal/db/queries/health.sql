-- name: Ping :one
-- Readiness check (GET /readyz, check "database").
SELECT 1::int AS ok;
