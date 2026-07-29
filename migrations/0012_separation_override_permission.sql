INSERT INTO operation_permissions (permission)
VALUES ('separation.override')
ON CONFLICT (permission) DO NOTHING;
