-- Add project code column
ALTER TABLE projects ADD COLUMN code TEXT DEFAULT NULL;

-- Populate existing projects with sequential codes (by id order)
UPDATE projects SET code = 'PRJ' || printf('%03d', (
  SELECT COUNT(*) FROM projects p2 WHERE p2.id <= projects.id
));

-- Create unique index for project code
CREATE UNIQUE INDEX idx_projects_code ON projects(code);
