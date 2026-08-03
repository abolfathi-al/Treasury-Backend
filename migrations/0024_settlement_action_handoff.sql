INSERT INTO operation_permissions (permission)
VALUES ('settlement.view')
ON CONFLICT (permission) DO NOTHING;
