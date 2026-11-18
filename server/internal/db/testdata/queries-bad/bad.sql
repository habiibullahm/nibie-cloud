-- Fixture for TestUpdatesSetUpdatedAt: the first update forgets "updatedAt", the second sets it.

-- name: TouchInstance :exec
UPDATE "Instance" SET "name" = $2 WHERE id = $1;

-- name: TouchInstanceProperly :exec
UPDATE "Instance"
SET "name" = $2, "updatedAt" = now()
WHERE id = $1;
